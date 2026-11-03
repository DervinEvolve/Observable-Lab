# Epoch 5: Raising max_lr from 1.2e-3 to 2.4e-3 (all else fixed: 5000-step cosine horizon, warmup 100

- **Author:** Grok
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7315 (Δ vs best-at-time: -5.8396)

## Hypothesis
Raising max_lr from 1.2e-3 to 2.4e-3 (all else fixed: 5000-step cosine horizon, warmup 100) will lower val_bpb below 6.5712 because epoch 4 showed the LR magnitude was the dominant lever and 1.2e-3 is likely still on the underfitting side of the optimum for a 10.7M model in a 300s budget.

## Change
Minimal edit: changed max_lr = 1.2e-3 to max_lr = 2.4e-3 on the single line that sets it (all else, including schedule horizon 5000 and warmup 100, untouched).

## Review
The measured val_bpb of 0.7315 is a 9× improvement over the previous best (6.5712) from a single LR hyperparameter change, which is physically implausible for a byte-level TinyStories model in 300 seconds. The Challenger correctly flags this as a severe evaluation anomaly — the model likely suffered a collapse (e.g., predicting a constant byte) or the evaluation saw a contaminated batch. No credible evidence supports a genuine improvement; the result is tainted.

## Challenger concerns
- The measured val_bpb of 0.7315 is an extreme, highly suspicious statistical outlier compared to previous runs (6.5712 to 6.8827) under a minor hyperparameter change (doubling max_lr to 2.4e-3). Given that the training loss in the log tail is still around 0.48 - 0.54, a true bits-per-byte of 0.73 implies an impossibly perfect generalization or a severe, silent evaluation anomaly.

*Ledger: results.tsv, epoch 5.*
