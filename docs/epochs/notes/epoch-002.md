# Epoch 2: Setting total_steps_estimate to a realistic ~4000 (matching actual step count) instead of 

- **Author:** GPT-5
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 7.0622 (Δ vs best-at-time: 0.1795)

## Hypothesis
Setting total_steps_estimate to a realistic ~4000 (matching actual step count) instead of 5000 will lower val_bpb by >0.05 because the cosine schedule currently never reaches its low-LR tail within the 300s budget, leaving the model over-annealing-starved and stuck at high LR when training ends.

## Change
Changed only the cosine schedule horizon in train(): total_steps_estimate is now 4000 instead of 5000. The adjacent comment was updated to document that this matches the observed ~4k steps in the fixed 300s budget; architecture, optimizer, batching, eval, and RESULT contract are untouched.

## Review
The proposed schedule change caused a major regression, with val_bpb degrading from 6.8827 to 7.0622. This strongly suggests that under-shooting the step estimate forces the learning rate to flatline at its minimum value (0.1 * max_lr) too early, starving the model of optimization energy during the critical middle-to-late phases of the 300s run.

## Challenger concerns
- Effect size (Δ+0.179 bpb) vastly exceeds any plausible single-hyperparameter schedule effect; points to possible silent interaction or numerical instability in lr_at_step when total_steps_estimate < actual steps
- Hypothesis predicted >0.05 improvement yet observed massive regression; single-run result cannot distinguish 'bad idea' from 'implementation error in cosine horizon'

*Ledger: results.tsv, epoch 2.*
