# Epoch 3: Increasing the cosine schedule horizon from 5000 to 50000 steps, keeping all else fixed, w

- **Author:** Grok
- **Verdict:** REVERT (run: ok)
- **val_bpb:** 7.9424 (Δ vs best-at-time: 1.0597)

## Hypothesis
Increasing the cosine schedule horizon from 5000 to 50000 steps, keeping all else fixed, will lower val_bpb below 6.8827 because the epoch-2 regression shows this short 300s run is harmed by reaching the low-LR tail too early; the model likely benefits from staying near max_lr through the full budget.

## Change
Changed total_steps_estimate from 5000 to 50000 (single-line edit in train()). This lengthens the cosine horizon exactly as hypothesized so the schedule stays closer to max_lr across the fixed 300s budget. No other code, constants, or logic touched.

## Review
The run completed but val_bpb regressed catastrophically from 6.8827 to 7.9424 (+1.06 bpb). The hypothesis that staying near max_lr helps was disproven; the model received almost no annealing and under-converged severely. The Epoch-2 regression was misdiagnosed as 'too much annealing' when it was actually 'annealing too fast, reaching minimum LR too early'. This experiment shows the opposite extreme is equally harmful.

## Challenger concerns
- The hypothesis that staying near max_lr would improve val_bpb is conclusively disproven; instead, preventing annealing caused severe under-convergence and a massive regression to 7.9424 bpb.
- The experimenters misattributed the Epoch 2 regression to 'reaching the low-LR tail too early' rather than realizing that a total_steps_estimate of 4000 forced the schedule to decay all the way to its absolute minimum too quickly, depriving the model of training velocity in the middle phase.

*Ledger: results.tsv, epoch 3.*
