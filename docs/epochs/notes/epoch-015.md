# Epoch 15: Increasing n_layer from 6 to 8 while keeping all other hyperparameters (n_embd=384, n_head

- **Author:** Gemini
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7213 (Δ vs best-at-time: 0.0146)

## Hypothesis
Increasing n_layer from 6 to 8 while keeping all other hyperparameters (n_embd=384, n_head=6, max_lr=1.2e-3, schedule horizon=4100, min_lr_ratio=0.1) will reduce val_bpb below 0.7067 because the additional transformer layers provide greater representational capacity to model byte-level TinyStories, and the reduction in total training steps (~24%) is compensated by the model's increased expressiveness.

## Change
In GPTConfig, changed the default n_layer value from 6 to 8. Similarly, in the non-smoke branch of train(), updated the local n_layer variable from 6 to 8 to reflect the capacity increase during the actual run.

## Review
Measured val_bpb=0.7213 regressed badly from the 0.7067 best — a ~0.015 loss. Deepening to 8 layers cut steps from 4335 to 3298 (~24% fewer updates) while raising per-step cost; the added capacity (10.7M→14.3M params) is nowhere near paid off in a 300s budget. Under a fixed wall-clock, the compute-bound regime favors more updates over more depth here.

## Challenger concerns
- Deeper model tested with completely untuned schedule/LR; the ~24% step reduction and higher per-step cost are confounded with optimization mismatch rather than pure capacity test.
- No verification that RMSNorm + SwiGLU initialization scales appropriately to 8 layers; residual scaling factor (1/sqrt(2L)) was never adjusted.

*Ledger: results.tsv, epoch 15.*
