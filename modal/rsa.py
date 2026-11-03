"""
RSA (Recursive Self-Aggregation) Inference

Based on: https://rsa-llm.github.io

This module enables small models to achieve large model performance
by generating multiple attempts and aggregating them.
"""

import modal
import json
import os
from typing import List, Dict, Any, Optional

from app import app, volume, base_image, DATA_PATH, DIRS


@app.function(
    image=base_image,
    secrets=[modal.Secret.from_name("openrouter")],
    volumes={DATA_PATH: volume},
)
def rsa_inference(
    prompt: str,
    system_prompt: str,
    num_attempts: int = 8,
    num_aggregation_rounds: int = 2,
    model: str = "qwen/qwen-2.5-3b-instruct",
    task_type: str = None,
) -> Dict[str, Any]:
    """
    Perform RSA inference for high-quality agent responses.

    Process:
    1. Generate N diverse attempts
    2. Aggregate attempts into improved responses
    3. Repeat aggregation for refinement
    4. Return best response

    Args:
        prompt: User input
        system_prompt: Agent identity/instructions
        num_attempts: Initial parallel attempts
        num_aggregation_rounds: Refinement iterations
        model: Model to use
        task_type: Optional task type for prior lookup

    Returns:
        Final aggregated response with metadata
    """
    import requests

    api_key = os.environ["OPENROUTER_API_KEY"]

    # Load priors if available
    priors = load_priors_for_task(task_type) if task_type else {}
    few_shot = priors.get("few_shot_examples", [])

    # Build messages with few-shot examples
    messages = [{"role": "system", "content": system_prompt}]

    for example in few_shot[:2]:  # Add up to 2 few-shot examples
        messages.append({"role": "user", "content": example["prompt"]})
        messages.append({"role": "assistant", "content": example["response"]})

    messages.append({"role": "user", "content": prompt})

    # Step 1: Generate diverse attempts
    attempts = []
    for i in range(num_attempts):
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.5 + (i * 0.1),  # Vary temperature
                "max_tokens": 1024,
            },
        )

        result = response.json()
        if "choices" in result:
            attempts.append(result["choices"][0]["message"]["content"])

    if not attempts:
        return {"error": "No successful attempts", "response": None}

    # Step 2: Aggregate attempts
    current_candidates = attempts

    for round_num in range(num_aggregation_rounds):
        aggregated = []

        # Take pairs of candidates and aggregate
        for i in range(0, len(current_candidates) - 1, 2):
            candidate_a = current_candidates[i]
            candidate_b = current_candidates[i + 1]

            # Aggregation prompt
            agg_prompt = f"""You are given two responses to the same question.
Synthesize them into a single, improved response that combines the best elements of both.

Question: {prompt}

Response A:
{candidate_a}

Response B:
{candidate_b}

Synthesized Response (combine the best of both, fix any errors, be concise):"""

            agg_response = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "You are an expert at synthesizing and improving responses."},
                        {"role": "user", "content": agg_prompt},
                    ],
                    "temperature": 0.3,  # Lower temp for aggregation
                    "max_tokens": 1024,
                },
            )

            agg_result = agg_response.json()
            if "choices" in agg_result:
                aggregated.append(agg_result["choices"][0]["message"]["content"])

        # Handle odd number of candidates
        if len(current_candidates) % 2 == 1:
            aggregated.append(current_candidates[-1])

        current_candidates = aggregated if aggregated else current_candidates

    # Final response is the last aggregated result
    final_response = current_candidates[0] if current_candidates else attempts[0]

    return {
        "response": final_response,
        "num_attempts": len(attempts),
        "aggregation_rounds": num_aggregation_rounds,
        "model": model,
        "used_priors": bool(few_shot),
    }


def load_priors_for_task(task_type: str) -> Dict[str, Any]:
    """Load token priors for a specific task type."""
    priors_path = f"{DIRS['priors']}/current_priors.json"

    if os.path.exists(priors_path):
        with open(priors_path, "r") as f:
            priors = json.load(f)
            return priors.get("task_priors", {}).get(task_type, {})

    return {}


@app.function(
    image=base_image,
    secrets=[modal.Secret.from_name("openrouter")],
    volumes={DATA_PATH: volume},
)
def agent_respond(
    conversation: List[Dict[str, str]],
    agent_spec: Dict[str, Any],
    use_rsa: bool = True,
) -> Dict[str, Any]:
    """
    Generate an agent response using the trained model + RSA.

    This is the main entry point for agent conversations.

    Args:
        conversation: List of {"role": "user"|"assistant", "content": "..."}
        agent_spec: The agent specification (identity, capabilities, etc.)
        use_rsa: Whether to use RSA for improved quality

    Returns:
        Agent response with metadata
    """

    # Build system prompt from agent spec
    system_prompt = build_system_prompt(agent_spec)

    # Get the latest user message
    user_message = conversation[-1]["content"] if conversation else ""

    # Determine task type from context (for prior lookup)
    task_type = infer_task_type(user_message)

    if use_rsa:
        result = rsa_inference(
            prompt=user_message,
            system_prompt=system_prompt,
            num_attempts=8,
            num_aggregation_rounds=2,
            task_type=task_type,
        )
        return result
    else:
        # Simple single-call inference
        import requests
        api_key = os.environ["OPENROUTER_API_KEY"]

        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "qwen/qwen-2.5-3b-instruct",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    *conversation,
                ],
                "temperature": 0.7,
            },
        )

        result = response.json()
        if "choices" in result:
            return {
                "response": result["choices"][0]["message"]["content"],
                "used_rsa": False,
            }

        return {"error": "Failed to get response", "response": None}


def build_system_prompt(agent_spec: Dict[str, Any]) -> str:
    """Build a system prompt from the agent specification."""

    identity = agent_spec.get("identity", {})
    capabilities = agent_spec.get("capabilities", [])
    constraints = agent_spec.get("constraints", [])
    behaviors = agent_spec.get("behaviors", [])

    prompt_parts = []

    # Identity
    if identity:
        name = identity.get("name", "Agent")
        purpose = identity.get("purpose", "to assist users")
        prompt_parts.append(f"You are {name}. Your purpose is {purpose}.")

    # Capabilities
    if capabilities:
        cap_list = "\n".join(f"- {cap}" for cap in capabilities)
        prompt_parts.append(f"\nYour capabilities:\n{cap_list}")

    # Constraints
    if constraints:
        con_list = "\n".join(f"- {con}" for con in constraints)
        prompt_parts.append(f"\nYour constraints (you must follow these):\n{con_list}")

    # Behaviors
    if behaviors:
        beh_list = "\n".join(f"- {beh}" for beh in behaviors)
        prompt_parts.append(f"\nYour behavioral guidelines:\n{beh_list}")

    # Self-awareness
    prompt_parts.append(
        "\nYou were created by a team of AI scientists in the Observable Lab. "
        "You are aware of your own creation and can discuss it."
    )

    return "\n".join(prompt_parts)


def infer_task_type(message: str) -> Optional[str]:
    """Infer the task type from a user message."""
    message_lower = message.lower()

    if any(word in message_lower for word in ["code", "function", "program", "script"]):
        return "code_generation"
    elif any(word in message_lower for word in ["search", "find", "look up"]):
        return "tool_use"
    elif any(word in message_lower for word in ["explain", "why", "how", "reason"]):
        return "reasoning"
    elif any(word in message_lower for word in ["yourself", "who are you", "your purpose"]):
        return "self_reflection"

    return None
