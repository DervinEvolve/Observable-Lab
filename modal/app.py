"""
Observable Lab - Modal Infrastructure

Virtual AI Lab training infrastructure using:
- Training-Free GRPO for continuous improvement
- Fine-tuning for milestone upgrades
- RSA (Recursive Self-Aggregation) for inference
"""

import modal

# Create the Modal app
app = modal.App("observable-lab")

# Persistent volume for all data
volume = modal.Volume.from_name("observable-lab-data", create_if_missing=True)

# Pinned images: the base by digest (official python:3.11.18-slim-bookworm
# multi-arch index) and every package by exact version, as resolved for
# Python 3.11 on 2026-11-02. These legacy images were not rebuilt on Modal
# after pinning; check them with a test deploy before relying on them.
PYTHON_BASE_IMAGE = "python:3.11.18-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd"

# Base image with ML dependencies
base_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install(
    "torch==2.15.0",
    "transformers==5.22.1",
    "datasets==5.1.0",
    "huggingface_hub==2.4.0",
    "requests==2.34.2",
    "pydantic==2.14.2",
    "fastapi==0.162.0",
)

# Training image with full fine-tuning dependencies
training_image = modal.Image.from_registry(PYTHON_BASE_IMAGE).pip_install(
    "torch==2.15.0",
    "transformers==5.22.1",
    "datasets==5.1.0",
    "peft==0.21.2",
    "trl==1.17.1",
    "accelerate==1.15.0",
    "bitsandbytes==0.50.2",
    "huggingface_hub==2.4.0",
    "wandb==0.31.0",
)

# Volume mount path
DATA_PATH = "/data"

# Directory structure
DIRS = {
    "generated_sft": f"{DATA_PATH}/data/generated/sft",
    "generated_dpo": f"{DATA_PATH}/data/generated/dpo",
    "generated_adversarial": f"{DATA_PATH}/data/generated/adversarial",
    "curated": f"{DATA_PATH}/data/curated",
    "combined": f"{DATA_PATH}/data/combined",
    "practice_tasks": f"{DATA_PATH}/grpo/practice_tasks",
    "rollouts": f"{DATA_PATH}/grpo/rollouts",
    "experiences": f"{DATA_PATH}/grpo/experiences",
    "priors": f"{DATA_PATH}/grpo/priors",
    "base_model": f"{DATA_PATH}/models/base",
    "checkpoints": f"{DATA_PATH}/models/checkpoints",
    "deployed": f"{DATA_PATH}/models/deployed",
    "benchmarks": f"{DATA_PATH}/evals/benchmarks",
    "results": f"{DATA_PATH}/evals/results",
}


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def initialize_volume():
    """Create the directory structure on first run."""
    import os

    for name, path in DIRS.items():
        os.makedirs(path, exist_ok=True)
        print(f"Created: {path}")

    volume.commit()
    return {"status": "initialized", "directories": list(DIRS.keys())}


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
)
def list_volume_contents():
    """List current contents of the volume."""
    import os

    contents = {}
    for name, path in DIRS.items():
        if os.path.exists(path):
            files = os.listdir(path)
            contents[name] = files[:10]  # First 10 files

    return contents


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
    secrets=[modal.Secret.from_name("huggingface")],
)
def download_dataset(dataset_name: str, subset: str = None, split: str = "train"):
    """Download a HuggingFace dataset to the curated directory."""
    import os
    from datasets import load_dataset

    print(f"Downloading {dataset_name}...")

    # Load dataset
    if subset:
        ds = load_dataset(dataset_name, subset, split=split)
    else:
        ds = load_dataset(dataset_name, split=split)

    # Save to volume
    safe_name = dataset_name.replace("/", "_")
    output_path = f"{DIRS['curated']}/{safe_name}"
    ds.save_to_disk(output_path)

    volume.commit()

    return {
        "dataset": dataset_name,
        "size": len(ds),
        "path": output_path,
    }


@app.function(
    image=base_image,
    volumes={DATA_PATH: volume},
    secrets=[modal.Secret.from_name("huggingface")],
)
def download_base_model(model_name: str = "Qwen/Qwen2.5-3B"):
    """Download base model for fine-tuning."""
    import os
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"Downloading {model_name}...")

    # Download model and tokenizer
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype="auto",
        device_map="auto",
    )

    # Save to volume
    safe_name = model_name.replace("/", "_")
    output_path = f"{DIRS['base_model']}/{safe_name}"

    tokenizer.save_pretrained(output_path)
    model.save_pretrained(output_path)

    volume.commit()

    return {
        "model": model_name,
        "path": output_path,
    }


# Entry point for CLI
@app.local_entrypoint()
def main():
    """Initialize the volume structure."""
    print("Initializing Observable Lab Modal infrastructure...")
    result = initialize_volume.remote()
    print(f"Result: {result}")
