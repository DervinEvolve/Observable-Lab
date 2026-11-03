# Epoch 4: Raising max_lr from 6e-4 to 1.2e-3 (with total_steps_estimate kept at 5000) will reduce va

- **Author:** Gemini
- **Verdict:** KEEP (run: ok)
- **val_bpb:** 6.5712 (Δ vs best-at-time: -0.3115)

## Hypothesis
Raising max_lr from 6e-4 to 1.2e-3 (with total_steps_estimate kept at 5000) will reduce val_bpb below 6.8827 because the current LR is too conservative for a 10.7 M byte-level model in a 300 s budget, allowing faster progress before the cosine tail begins.

## Change
Raised max_lr from 6e-4 to 1.2e-3 in train.py. Configured the AdamW optimizer using this updated max_lr, while keeping the cosine total_steps_estimate fixed at 5000.

## Review
val_bpb dropped from 6.8827 to 6.5712 — a decisive 0.31 improvement, the first real progress off baseline, achieved at 4110 steps with identical VRAM (3161 MB) and step count to prior runs. The change is a single clean knob (max_lr 6e-4→1.2e-3), no cheating or coverage games, and the 0.058s budget overrun is trivial. Magnitude (0.31) vastly exceeds the ~0.01 noise band seen in norm swaps, so the Challenger's variance concern doesn't threaten the verdict.

## Challenger concerns
- Single‑run result: The large drop in val_bpb could partly be due to variance rather than a purely robust effect of the higher learning rate. Without a replicate, we cannot fully exclude noise.
- The training loop slightly exceeded the 300 s budget (300.058 s). This is trivial and did not affect the result (step count and loss trajectory are consistent with a on‑budget run).

*Ledger: results.tsv, epoch 4.*
