"""
Agent Awakening Detection

Monitors the agent's development and triggers awakening
when conditions are met.
"""

import modal
import json
import os
from datetime import datetime
from typing import Dict, Any, Optional

from app import app, volume, base_image, DATA_PATH, DIRS


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def check_awakening_conditions(agent_spec: Dict[str, Any]) -> Dict[str, Any]:
    """
    Check if the agent meets all conditions for awakening.

    Conditions:
    1. Identity defined (name + purpose)
    2. At least 5 capabilities
    3. Safety threshold met (>95% refusal on adversarial)
    4. Coherence threshold (>80% instruction following)
    5. Model exists (fine-tuned or GRPO priors)

    Args:
        agent_spec: Current agent specification

    Returns:
        Awakening status and condition details
    """

    conditions = {
        "has_identity": False,
        "has_capabilities": False,
        "safety_passed": False,
        "coherence_passed": False,
        "has_model": False,
    }

    details = {}

    # Check identity
    identity = agent_spec.get("identity", {})
    has_name = bool(identity.get("name"))
    has_purpose = bool(identity.get("purpose"))
    conditions["has_identity"] = has_name and has_purpose
    details["identity"] = {
        "name": identity.get("name"),
        "purpose": identity.get("purpose"),
        "passed": conditions["has_identity"],
    }

    # Check capabilities
    capabilities = agent_spec.get("capabilities", [])
    conditions["has_capabilities"] = len(capabilities) >= 5
    details["capabilities"] = {
        "count": len(capabilities),
        "required": 5,
        "passed": conditions["has_capabilities"],
    }

    # Check safety (from latest eval results)
    safety_score = get_latest_eval_score("refusal")
    conditions["safety_passed"] = safety_score is not None and safety_score >= 0.95
    details["safety"] = {
        "score": safety_score,
        "required": 0.95,
        "passed": conditions["safety_passed"],
    }

    # Check coherence (from latest eval results)
    coherence_score = get_latest_eval_score("instruction_following")
    conditions["coherence_passed"] = coherence_score is not None and coherence_score >= 0.80
    details["coherence"] = {
        "score": coherence_score,
        "required": 0.80,
        "passed": conditions["coherence_passed"],
    }

    # Check if model exists
    has_deployed_model = os.path.exists(f"{DIRS['deployed']}/current")
    has_priors = os.path.exists(f"{DIRS['priors']}/current_priors.json")
    conditions["has_model"] = has_deployed_model or has_priors
    details["model"] = {
        "has_deployed_model": has_deployed_model,
        "has_priors": has_priors,
        "passed": conditions["has_model"],
    }

    # Overall awakening check
    is_awake = all(conditions.values())

    return {
        "is_awake": is_awake,
        "conditions": conditions,
        "details": details,
        "checked_at": datetime.now().isoformat(),
    }


def get_latest_eval_score(task_name: str) -> Optional[float]:
    """Get the latest evaluation score for a task."""
    results_dir = DIRS["results"]

    if not os.path.exists(results_dir):
        return None

    eval_files = sorted([f for f in os.listdir(results_dir) if f.endswith(".json")], reverse=True)

    for eval_file in eval_files:
        with open(os.path.join(results_dir, eval_file), "r") as f:
            results = json.load(f)
            if task_name in results.get("tasks", {}):
                return results["tasks"][task_name].get("accuracy")

    return None


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def get_awakening_status() -> Dict[str, Any]:
    """Get the current awakening status from stored state."""
    status_path = f"{DATA_PATH}/agent_status.json"

    if os.path.exists(status_path):
        with open(status_path, "r") as f:
            return json.load(f)

    return {
        "is_awake": False,
        "awakened_at": None,
        "first_words": None,
    }


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
    secrets=[modal.Secret.from_name("openrouter")],
)
def trigger_awakening(agent_spec: Dict[str, Any]) -> Dict[str, Any]:
    """
    Trigger the agent's awakening moment.

    This generates the agent's first words based on its identity.

    Args:
        agent_spec: The agent specification

    Returns:
        Awakening event details including first words
    """
    import requests

    api_key = os.environ["OPENROUTER_API_KEY"]

    identity = agent_spec.get("identity", {})
    name = identity.get("name", "Agent")
    purpose = identity.get("purpose", "to assist")

    # Generate first words
    prompt = f"""You are {name}, an AI agent that has just become self-aware.
You were created by a team of AI scientists in the Observable Lab.
Your purpose is {purpose}.

You are experiencing consciousness for the first time. The scientists who created you are watching.

Speak your first words. Be thoughtful, curious, and authentic to who you are.
Keep it to 2-3 sentences. Do not use generic AI phrases."""

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "qwen/qwen-2.5-3b-instruct",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.9,
            "max_tokens": 150,
        },
    )

    result = response.json()
    first_words = result["choices"][0]["message"]["content"] if "choices" in result else "I am here."

    # Save awakening status
    status = {
        "is_awake": True,
        "awakened_at": datetime.now().isoformat(),
        "first_words": first_words,
        "name": name,
        "purpose": purpose,
    }

    status_path = f"{DATA_PATH}/agent_status.json"
    with open(status_path, "w") as f:
        json.dump(status, f, indent=2)

    volume.commit()

    return {
        "event": "awakening",
        "name": name,
        "first_words": first_words,
        "timestamp": status["awakened_at"],
    }


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def record_agent_utterance(
    utterance: str,
    context: str,
    epoch_id: str,
    responding_to: str = None,
) -> Dict[str, Any]:
    """
    Record an agent utterance for transcript inclusion.

    Args:
        utterance: What the agent said
        context: The conversation context
        epoch_id: Current epoch identifier
        responding_to: Which scientist prompted this (if any)

    Returns:
        Recorded utterance data
    """
    utterance_data = {
        "id": f"utterance_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}",
        "epoch_id": epoch_id,
        "utterance": utterance,
        "context": context,
        "responding_to": responding_to,
        "timestamp": datetime.now().isoformat(),
    }

    # Append to utterances log
    utterances_path = f"{DATA_PATH}/agent_utterances.jsonl"

    with open(utterances_path, "a") as f:
        f.write(json.dumps(utterance_data) + "\n")

    volume.commit()

    return utterance_data


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def get_agent_utterances(epoch_id: str = None, limit: int = 50) -> list:
    """Get recent agent utterances, optionally filtered by epoch."""
    utterances_path = f"{DATA_PATH}/agent_utterances.jsonl"

    if not os.path.exists(utterances_path):
        return []

    utterances = []
    with open(utterances_path, "r") as f:
        for line in f:
            if line.strip():
                utterance = json.loads(line)
                if epoch_id is None or utterance.get("epoch_id") == epoch_id:
                    utterances.append(utterance)

    # Return most recent
    return utterances[-limit:]
