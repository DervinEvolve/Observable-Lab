# Epoch 11: Increasing the cosine schedule horizon from 5000 to 10000 steps (max_lr=1.2e-3 unchanged) 

- **Author:** GPT-5
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 0.7357 (Δ vs best-at-time: 0.0201)

## Hypothesis
Increasing the cosine schedule horizon from 5000 to 10000 steps (max_lr=1.2e-3 unchanged) will reduce val_bpb below 0.7156 because the current rapid decay to ~10% of max_lr by step 4100 starves the model of learning signal in the final phase; a flatter decay keeps LR higher through the 300s budget, allowing continued progress.

## Change
Changed only the cosine LR schedule horizon in train(args): total_steps_estimate is now 10000 instead of 5000. I left max_lr=1.2e-3, warmup_steps=100, architecture, batch size, sequence length, optimizer, evaluation, and RESULT contract unchanged. Added a short local comment documenting that this tests a flatter decay under the same 300s budget.

## Review
The run completed but regressed hard: val_bpb=0.7357 vs best 0.7156 (+0.0201). Despite more steps (4319 vs 4170), the flatter schedule left LR too high at budget end, starving the model of the low-LR annealing phase that consolidates gains. The Challenger's critique is confirmed by the number — decay to minimum matters more than staying warm.

## Challenger concerns
- Flatter cosine schedule prevents learning rate annealing to its minimum, causing severe under-optimization at the end of the budget.

*Ledger: results.tsv, epoch 11.*
