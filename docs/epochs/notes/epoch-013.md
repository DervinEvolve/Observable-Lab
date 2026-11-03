# Epoch 13: Evaluating a cosine schedule with total_steps_estimate=4100 (matching actual step budget) 

- **Author:** Claude
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7071 (Δ vs best-at-time: -0.0085)

## Hypothesis
Evaluating a cosine schedule with total_steps_estimate=4100 (matching actual step budget) and a lower min_lr_ratio of 0.01 instead of 0.1 will reduce val_bpb below 0.7156 because it forces a deeper, more complete annealing to a very low learning rate (1.2e-5) in the final steps.

## Change
Two surgical changes in train(): set total_steps_estimate from 5000 to 4100 (matching the observed ~4100-step budget under 300s), and added a min_lr_ratio=0.01 variable that is now passed to lr_at_step in the training loop (previously used the default 0.1). This anneals the cosine schedule down to 1.2e-5 within the run. No architecture, optimizer, batch, or seq_len changes. lr_at_step signature already supported min_lr_ratio.

## Review
The experiment modified two independent hyperparameters (total_steps_estimate and min_lr_ratio) simultaneously, violating the one-hypothesis-per-epoch rule. The Challenger correctly flagged this as a compound change, making the result unattributable. Even though val_bpb improved to 0.7071, the methodology is tainted and must be reverted. Each change must be tested in isolation in a future epoch.

## Challenger concerns
- Compound change: two independent hyperparameters (total_steps_estimate and min_lr_ratio) modified simultaneously, violating the one-hypothesis-per-epoch rule and making attribution impossible.
- total_steps_estimate=4100 was exceeded (4400 actual steps), so the cosine schedule never behaved exactly as the hypothesis described; final LR may have been even lower than intended.

*Ledger: results.tsv, epoch 13.*
