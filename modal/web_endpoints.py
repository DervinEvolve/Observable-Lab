"""
Web Endpoints for Observable Lab Modal Functions

These endpoints are called by Vercel serverless functions
to trigger GRPO practice, check awakening, and get agent responses.
"""

import modal
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import hmac
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json
import os
from datetime import datetime

from app import app, volume, base_image, DATA_PATH, DIRS

# Create FastAPI app for web endpoints
web_app = FastAPI()


@web_app.middleware("http")
async def require_operator(request: Request, call_next):
    if request.url.path == "/health" and request.method == "GET":
        return await call_next(request)
    expected = os.environ.get("MODAL_API_TOKEN", "")
    if len(expected) < 32:
        return JSONResponse(status_code=503, content={"error": "Operator access is not configured"})
    supplied = request.headers.get("authorization", "")
    if not hmac.compare_digest(supplied.encode(), f"Bearer {expected}".encode()):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"},
                            headers={"WWW-Authenticate": "Bearer"})
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


# ============ Request/Response Models ============

class PracticeTask(BaseModel):
    id: str
    type: str
    prompt: str
    verification: Dict[str, Any]


class AgentConfig(BaseModel):
    model: str = "qwen/qwen-2.5-3b-instruct"
    system_prompt: str


class GRPOPracticeRequest(BaseModel):
    tasks: List[PracticeTask]
    agent_config: AgentConfig


class AgentSpec(BaseModel):
    identity: Dict[str, Any] = {}
    capabilities: List[Dict[str, Any]] = []
    constraints: List[Dict[str, Any]] = []
    behaviors: List[Dict[str, Any]] = []
    meta: Dict[str, Any] = {}


class AwakeningCheckRequest(BaseModel):
    agent_spec: AgentSpec


class AgentRespondRequest(BaseModel):
    conversation: List[Dict[str, str]]
    agent_spec: AgentSpec
    use_rsa: bool = True


class RecordUtteranceRequest(BaseModel):
    utterance: str
    context: str
    epoch_id: str
    responding_to: Optional[str] = None


# ============ Web Endpoints ============

@web_app.post("/grpo/practice")
async def grpo_practice_endpoint(request: GRPOPracticeRequest):
    """Run GRPO practice session."""
    from grpo import run_rollout, extract_experiences, update_priors

    results = {
        "tasks_attempted": len(request.tasks),
        "rollouts": [],
        "timestamp": datetime.now().isoformat(),
    }

    agent_config = {
        "model": request.agent_config.model,
        "system_prompt": request.agent_config.system_prompt,
    }

    # Run rollouts for each task
    for task in request.tasks:
        task_dict = task.model_dump()
        try:
            rollout = run_rollout.remote(task_dict, agent_config, num_attempts=5)
            results["rollouts"].append({
                "task_id": task.id,
                "success_rate": rollout.get("success_rate", 0),
            })
        except Exception as e:
            results["rollouts"].append({
                "task_id": task.id,
                "error": str(e),
                "success_rate": 0,
            })

    # Extract experiences
    try:
        experiences = extract_experiences.remote()
        results["experiences_extracted"] = experiences.get("successful_attempts", 0)
    except Exception as e:
        results["experiences_extracted"] = 0
        results["experiences_error"] = str(e)

    # Update priors
    try:
        priors = update_priors.remote()
        results["priors_version"] = priors.get("version", "unknown")
    except Exception as e:
        results["priors_version"] = "error"
        results["priors_error"] = str(e)

    return results


@web_app.post("/awakening/check")
async def check_awakening_endpoint(request: AwakeningCheckRequest):
    """Check if agent meets awakening conditions."""
    from awakening import check_awakening_conditions

    spec_dict = request.agent_spec.model_dump()
    result = check_awakening_conditions.remote(spec_dict)
    return result


@web_app.post("/awakening/trigger")
async def trigger_awakening_endpoint(request: AwakeningCheckRequest):
    """Trigger agent awakening."""
    from awakening import trigger_awakening

    spec_dict = request.agent_spec.model_dump()
    result = trigger_awakening.remote(spec_dict)
    return result


@web_app.get("/awakening/status")
async def get_awakening_status_endpoint():
    """Get current awakening status."""
    from awakening import get_awakening_status

    result = get_awakening_status.remote()
    return result


@web_app.post("/agent/respond")
async def agent_respond_endpoint(request: AgentRespondRequest):
    """Get agent response using RSA inference."""
    from rsa import agent_respond

    spec_dict = request.agent_spec.model_dump()
    result = agent_respond.remote(
        conversation=request.conversation,
        agent_spec=spec_dict,
        use_rsa=request.use_rsa,
    )
    return result


@web_app.post("/agent/utterance")
async def record_utterance_endpoint(request: RecordUtteranceRequest):
    """Record agent utterance for transcripts."""
    from awakening import record_agent_utterance

    result = record_agent_utterance.remote(
        utterance=request.utterance,
        context=request.context,
        epoch_id=request.epoch_id,
        responding_to=request.responding_to,
    )
    return result


@web_app.get("/agent/utterances")
async def get_utterances_endpoint(epoch_id: Optional[str] = None, limit: int = 50):
    """Get recent agent utterances."""
    from awakening import get_agent_utterances

    result = get_agent_utterances.remote(epoch_id=epoch_id, limit=limit)
    return result


@web_app.get("/priors/current")
async def get_current_priors_endpoint():
    """Get current token priors."""
    from grpo import get_current_priors

    result = get_current_priors.remote()
    return result


@web_app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


# ============ Mount FastAPI to Modal ============

@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
    secrets=[
        modal.Secret.from_name("openrouter"),
        modal.Secret.from_name("huggingface"),
        modal.Secret.from_name("observable-lab-web-auth"),
    ],
    allow_concurrent_inputs=10,
)
@modal.asgi_app()
def web():
    """Mount the FastAPI app as a Modal ASGI endpoint."""
    return web_app

