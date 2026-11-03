"""Build the readable epoch archive from the checked-in records, offline."""

from pathlib import Path
from collections import Counter
import csv
import hashlib
import html
import json
import math
import re


ARCHIVE = Path(__file__).resolve().parents[1] / "docs" / "epochs"
TITLES = {
    1: "Try RMSNorm on the early setup",
    2: "Shorten the training schedule",
    3: "Lengthen the training schedule",
    4: "Increase the learning rate",
    5: "Investigate a surprising score",
    6: "Try another learning rate on TinyStories",
    7: "Try RMSNorm on TinyStories",
    8: "Change text length and batch size",
    9: "Try a different model building block",
    10: "Try rotary position information",
    11: "Lengthen the schedule again",
    12: "Shorten the schedule toward the observed run",
    13: "Change two schedule settings together",
    14: "Test the schedule length by itself",
    15: "Use a deeper model",
    16: "Lower the final learning rate",
    17: "Double the learning-rate scale",
    18: "Increase the training batch",
    19: "Reduce the training batch",
    20: "Try lower weight decay; training crashes",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git_blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def quoted(value):
    text = html.escape(str(value), quote=False).replace("![", "\\![")
    return "\n".join("> " + line for line in text.splitlines()) + "\n\n"


def code(value, language="text"):
    text = value if isinstance(value, str) else json.dumps(value, indent=2)
    fence = "`" * max(3, 1 + max((len(m[0]) for m in re.finditer(r"`+", text)), default=0))
    return f"{fence}{language}\n{text.rstrip()}\n{fence}\n\n"


def details(title, body):
    return f"<details>\n<summary>{title}</summary>\n\n{body}</details>\n\n"


manifest = json.loads((ARCHIVE / "source-manifest.json").read_text())
raw_ledger = (ARCHIVE / "results-original.tsv").read_bytes()
require(git_blob(raw_ledger) == manifest["ledger"]["blob"], "Ledger differs from its pinned source")
rows = list(csv.DictReader(raw_ledger.decode().splitlines(), delimiter="\t"))
counts = Counter(int(row["epoch"]) for row in rows)
require(set(counts) == set(TITLES), "Expected saved epochs 1–20")
first_row = {}
for row in rows:
    number = int(row["epoch"])
    first_row.setdefault(number, row)
    require(row["status"] in {"keep", "discard", "crash"}, "Unknown recorded status")
    if row["val_bpb"] != "-":
        value = float(row["val_bpb"])
        require(math.isfinite(value) and value >= 0, "Invalid prediction score")

for source in manifest["findings"]:
    path = ARCHIVE / "notes" / f"epoch-{source['epoch']:03d}.md"
    require(git_blob(path.read_bytes()) == source["blob"], f"Changed original note: {path.name}")
    match = re.search(r"\*\*val_bpb:\*\* ([0-9.]+)", path.read_text())
    if match:
        require(abs(float(match[1]) - float(first_row[source["epoch"]]["val_bpb"])) < 0.0001,
                f"Note/ledger score mismatch for epoch {source['epoch']}")

turns_bytes = (ARCHIVE / "role-outputs.json").read_bytes()
require(hashlib.sha256(turns_bytes).hexdigest() == manifest["exported_role_outputs_sha256"],
        "Role-output export differs from its recorded checksum")
turns = json.loads(turns_bytes)
require({row["epoch_number"] for row in turns} == {16, 17, 18, 19, 20}, "Unexpected transcript coverage")
(ARCHIVE / "transcripts").mkdir(exist_ok=True)
for epoch in turns:
    number = epoch["epoch_number"]
    result = (epoch.get("research_run") or {}).get("result") or {}
    metrics = result.get("metrics") or {}
    if metrics.get("val_bpb") is not None:
        require(abs(float(metrics["val_bpb"]) - float(first_row[number]["val_bpb"])) < 0.0001,
                f"Transcript/ledger score mismatch for epoch {number}")
    body = f"# Epoch {number}: {TITLES[number]}\n\n"
    body += "[Archive index](../README.md) · " + f"[Saved findings note](../notes/epoch-{number:03d}.md)\n\n"
    body += "The remarks and notes below are the stored model outputs from this round. "
    body += "The named agents are participants in the experiment. Their interpretations are preserved as recorded.\n\n"
    if not epoch.get("completed_at"):
        body += "**Partial record:** the saved round ends after the Reviewer. A Commentator reply is missing.\n\n"
    body += "## Recorded run\n\n"
    body += f"- Status: {result.get('status', 'unavailable')}\n"
    body += f"- Training-time target: {(epoch.get('research_run') or {}).get('budget_s', 'unavailable')} seconds\n"
    if metrics.get("val_bpb") is not None:
        body += f"- Reported prediction score: {metrics['val_bpb']:.4f} bits per byte; lower is better\n"
    if metrics.get("train_steps") is not None:
        body += f"- Training steps: {metrics['train_steps']}\n"
    body += "\n"
    if result.get("error"):
        body += details("Recorded error", code(result["error"]))
    if result.get("log_tail"):
        body += details("Training log excerpt", code(result["log_tail"]))
    for role in ("planner", "executor", "challenger", "reviewer", "commentator"):
        output = epoch.get(role + "_output")
        if not output:
            continue
        assigned = epoch["role_assignments"][role]
        body += f"## {role.title()}: {html.escape(str(assigned), quote=False)}\n\n"
        if output.get("remark"):
            body += quoted(output["remark"])
        labels = {
            "hypothesis": "Proposed test", "motivation": "Why try it", "expected_effect": "Expected result",
            "change_summary": "Change made", "verdict": "Decision", "reason": "Reason for the decision",
            "summary": "Round summary", "notebook": "Notebook entry", "recommendation": "Recommendation",
            "overall_risk": "Recorded risk rating", "for_returning_visitors": "Visitor summary",
        }
        for key, label in labels.items():
            if output.get(key):
                body += f"**{label}**\n\n" + quoted(output[key])
        for index, concern in enumerate(output.get("challenges") or [], 1):
            body += f"### Concern {index}\n\n" + quoted(concern.get("issue", ""))
            if concern.get("suggested_fix"):
                body += "**Suggested follow-up**\n\n" + quoted(concern["suggested_fix"])
            if concern.get("example_scenario"):
                body += details("Example from the saved output", quoted(concern["example_scenario"]))
        if output.get("conflicts_with_existing"):
            body += details("Conflicts raised", "".join(quoted(v) for v in output["conflicts_with_existing"]))
        if output.get("reasoning"):
            body += details("Agent's recorded reasoning notes", quoted(output["reasoning"]))
        if output.get("train_py"):
            body += details("Generated train.py", code(output["train_py"], "python"))
    (ARCHIVE / "transcripts" / f"epoch-{number:03d}.md").write_text(body)

index = """# The early Observable Lab run

These are the saved notes for epochs 1–20. An epoch is one round of proposals, a test and a review. I kept the original findings notes, and made the available role-by-role conversations easier to read.

## Start here

- [Epochs 13](notes/epoch-013.md) and [14](notes/epoch-014.md): the group asks for a clearer test after two settings changed together.
- [Epoch 14's challenger concerns](notes/epoch-014.md#challenger-concerns): an agent checks the learning-rate explanation against the actual calculation.
- [Epoch 15](notes/epoch-015.md): the deeper model completes fewer training steps within the time limit.
- [Epoch 17 conversation](transcripts/epoch-017.md): the challenger asks the group to describe exactly which learning-rate settings changed.
- [Epoch 19 conversation](transcripts/epoch-019.md): the smaller batch produces more updates and a worse reported score; the challenger raises a schedule mismatch.
- [Epoch 20 conversation](transcripts/epoch-020.md): the training program fails to parse, and the recorded conversation ends after the Reviewer.

## Reading the results

The score is `val_bpb`, or validation bits per byte. It measures how well the model predicts test text. Lower is better. The training programs calculate these scores themselves. Independent evaluation and repeat runs are still planned.

Dataset descriptions change around epochs 5–6. The later notes explicitly describe TinyStories; the older experiment description refers to enwik8. Early ledger rows have empty dataset and harness-version fields. Comparisons need the same dataset and evaluation setup.

The original notes include strong claims from the agents, including claims of statistical significance. Those statements belong to the recorded discussion. A repeated-run study is still needed to establish the size and reliability of an effect.

The `Author` field in each saved note identifies the agent that supplied the training code. The role transcripts include each participant's remark, proposed test, objections and recorded notes.

## Epoch index

There is one index entry per epoch number. Notes are available for all twenty rounds. Turn-by-turn outputs are available for epochs 16–20; epoch 20 is partial.

| Epoch | Test | Reported score | Recorded decision | Conversation |
| --- | --- | ---: | --- | --- |
"""
for number, title in TITLES.items():
    row = first_row[number]
    score = row["val_bpb"] if row["val_bpb"] != "-" else "unavailable"
    decision = {"keep": "kept", "discard": "reverted", "crash": "training failed"}[row["status"]]
    conversation = f"[Read](transcripts/epoch-{number:03d}.md)" if number >= 16 else "saved note"
    if number == 20:
        conversation += " (partial)"
    index += f"| [{number}](notes/epoch-{number:03d}.md) | {title} | {score} | {decision} | {conversation} |\n"
index += f"""
## A quirk in the ledger

The [original results file](results-original.tsv) contains {len(rows):,} rows. {counts[20]:,} carry epoch number 20. The index groups them under that one round. The source file is preserved unchanged.

The resume code can reuse a saved training result and write another ledger row before later narration finishes. This allows a later interruption to produce another entry for the same result. The saved epoch-20 training error is a Python syntax error. I may have run out of provider credits during the later interruptions. I still need to check the provider records and model availability before the next run.

## Words used in the notes

- **Batch:** the group of training examples used for one update.
- **Learning rate:** the size of the model's weight updates.
- **Schedule or horizon:** how those update sizes change over the course of training.
- **Baseline:** the earlier setup a proposed change is compared with.
- **Keep / revert:** the group's decision to retain or reject the proposed code change.
- **Crash:** a failed program run with an unavailable prediction score.

## Source record

The findings notes and ledger come from the Research-Lab revision `{manifest['research_revision']}`. The role outputs were read from Observable Lab's public experiment-state API. [The source manifest](source-manifest.json) records the original file identifiers and checksums. [role-outputs.json](role-outputs.json) preserves the exported turn data.

The archive generator runs offline:

```sh
python3 scripts/build-epoch-archive.py
```

I'm planning a fresh run soon with updated models. I'll keep this early run here so the proposals, reviews and failures remain available alongside the new work.
"""
(ARCHIVE / "README.md").write_text(index)
profile = {
    "ledger_rows": len(rows), "unique_epoch_numbers": len(counts),
    "rows_per_epoch": dict(sorted(counts.items())),
    "exact_duplicate_rows": len(rows) - len({tuple(sorted(row.items())) for row in rows}),
    "findings_note_count": len(manifest["findings"]), "turn_transcript_epochs": [row["epoch_number"] for row in turns],
    "partial_transcript_epochs": [row["epoch_number"] for row in turns if not row.get("completed_at")],
    "source_blob_checks": "all notes and ledger match the pinned source",
    "score_reconciliation": "findings notes and available role outputs agree with rounded ledger scores",
    "independent_model_evaluation": "unfinished",
}
(ARCHIVE / "record-checks.json").write_text(json.dumps(profile, indent=2) + "\n")
print(f"Built {len(manifest['findings'])} note links and {len(turns)} readable transcripts; {len(rows)} ledger rows cover {len(counts)} epoch numbers.")
