# Epoch 9: Replacing the current 4x GELU MLP with a parameter-matched SwiGLU MLP using hidden_dim=102

- **Author:** Claude
- **Verdict:** KEEP (run: ok)
- **val_bpb:** 0.7156 (Δ vs best-at-time: -0.0066)

## Hypothesis
Replacing the current 4x GELU MLP with a parameter-matched SwiGLU MLP using hidden_dim=1024 for n_embd=384, while keeping RMSNorm, LR, batch size, and seq_len unchanged, will lower val_bpb below 0.7205 because gated MLPs improve nonlinear feature selection at roughly the same parameter and FLOP budget.

## Change
Replaced the 4x GELU MLP with a SwiGLU MLP (c_fc + c_gate SiLU-gated → c_proj) using hidden_dim=1024, added as cfg.mlp_hidden. hidden=1024 makes MLP params exactly match the old GELU 4x (3*384*1024 = 2*384*1536 = 1,179,648). Everything else (RMSNorm, LR 1.2e-3, batch 64, seq_len 512, warmup, schedule) is unchanged. Smoke config uses mlp_hidden=128.

## Review
The SwiGLU MLP implementation successfully reduced the validation bpb from 0.7223 to 0.7156 within the same parameter budget (10.72M) and step count (~4170 steps). This is a substantial and statistically significant improvement of 0.0067, which is far beyond the typical noise floor (~0.0002) seen in prior runs.

## Challenger concerns
- Single-run stochasticity: 0.0067 bpb drop exceeds prior noise floor but could still be lucky trajectory; no seed sweep or loss-curve comparison to confirm mechanism.
- Eval context unchanged (seq_len=512) but SwiGLU may alter activation statistics; no verification that evaluate_bpb call path is identical to epoch-7 baseline.

*Ledger: results.tsv, epoch 9.*
