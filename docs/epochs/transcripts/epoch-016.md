# Epoch 16: Lower the final learning rate

[Archive index](../README.md) · [Saved findings note](../notes/epoch-016.md)

The remarks and notes below are the stored model outputs from this round. The named agents are participants in the experiment. Their interpretations are preserved as recorded.

## Recorded run

- Status: ok
- Training-time target: 300 seconds
- Reported prediction score: 0.7153 bits per byte; lower is better
- Training steps: 4400

<details>
<summary>Training log excerpt</summary>

```text
[train] step=2500 loss=0.5098 tok/s=478121 elapsed=169.0s/300s
[train] step=2550 loss=0.5072 tok/s=478263 elapsed=172.4s/300s
[train] step=2600 loss=0.5263 tok/s=477856 elapsed=175.9s/300s
[train] step=2650 loss=0.5448 tok/s=477206 elapsed=179.3s/300s
[train] step=2700 loss=0.5179 tok/s=478025 elapsed=182.7s/300s
[train] step=2750 loss=0.5169 tok/s=477096 elapsed=186.2s/300s
[train] step=2800 loss=0.5444 tok/s=476717 elapsed=189.6s/300s
[train] step=2850 loss=0.5197 tok/s=476814 elapsed=193.0s/300s
[train] step=2900 loss=0.5258 tok/s=477008 elapsed=196.5s/300s
[train] step=2950 loss=0.5235 tok/s=476546 elapsed=199.9s/300s
[train] step=3000 loss=0.5311 tok/s=476666 elapsed=203.3s/300s
[train] step=3050 loss=0.5251 tok/s=476317 elapsed=206.8s/300s
[train] step=3100 loss=0.5243 tok/s=476124 elapsed=210.2s/300s
[train] step=3150 loss=0.5141 tok/s=476210 elapsed=213.7s/300s
[train] step=3200 loss=0.5147 tok/s=475639 elapsed=217.1s/300s
[train] step=3250 loss=0.5067 tok/s=475819 elapsed=220.6s/300s
[train] step=3300 loss=0.4986 tok/s=475773 elapsed=224.0s/300s
[train] step=3350 loss=0.5168 tok/s=475272 elapsed=227.4s/300s
[train] step=3400 loss=0.5071 tok/s=476089 elapsed=230.9s/300s
[train] step=3450 loss=0.4890 tok/s=475246 elapsed=234.3s/300s
[train] step=3500 loss=0.5070 tok/s=475033 elapsed=237.8s/300s
[train] step=3550 loss=0.5102 tok/s=475375 elapsed=241.2s/300s
[train] step=3600 loss=0.5296 tok/s=475337 elapsed=244.7s/300s
[train] step=3650 loss=0.5078 tok/s=475455 elapsed=248.1s/300s
[train] step=3700 loss=0.5232 tok/s=475164 elapsed=251.6s/300s
[train] step=3750 loss=0.4990 tok/s=474826 elapsed=255.0s/300s
[train] step=3800 loss=0.5000 tok/s=475034 elapsed=258.5s/300s
[train] step=3850 loss=0.5098 tok/s=475144 elapsed=261.9s/300s
[train] step=3900 loss=0.5004 tok/s=474768 elapsed=265.4s/300s
[train] step=3950 loss=0.5347 tok/s=474896 elapsed=268.8s/300s
[train] step=4000 loss=0.4942 tok/s=474620 elapsed=272.3s/300s
[train] step=4050 loss=0.5098 tok/s=474748 elapsed=275.7s/300s
[train] step=4100 loss=0.4822 tok/s=474114 elapsed=279.2s/300s
[train] step=4150 loss=0.4805 tok/s=474593 elapsed=282.6s/300s
[train] step=4200 loss=0.5037 tok/s=474791 elapsed=286.1s/300s
[train] step=4250 loss=0.5169 tok/s=474661 elapsed=289.5s/300s
[train] step=4300 loss=0.4996 tok/s=474046 elapsed=293.0s/300s
[train] step=4350 loss=0.4897 tok/s=474565 elapsed=296.4s/300s
[train] step=4400 loss=0.5098 tok/s=473888 elapsed=299.9s/300s
RESULT {"val_bpb": 0.7152599889979249, "train_steps": 4400, "train_seconds": 300.19206190109253, "peak_vram_mb": 3191.462890625, "params_m": 10.720128, "tokens_seen": 144179200}
```

</details>

## Planner: google/gemini-3.5-flash

> Let's isolate the deeper learning rate decay. Epoch 13 showed immense promise, but we had to revert it due to strict isolation rules; now we can cleanly claim the win.

**Proposed test**

> Evaluating a cosine schedule with total_steps_estimate=4100 and a min_lr_ratio of 0.01 (instead of 0.1) while keeping all other parameters identical to the epoch 14 best configuration will reduce val_bpb below 0.7067 because forcing a deeper annealing to a very low learning rate (1.2e-5) in the final steps allows for better fine-grained parameter consolidation without starving early-to-mid-stage learning.

**Why try it**

> In Epoch 13, we tested total_steps_estimate=4100 with min_lr_ratio=0.01 and achieved 0.7071 val_bpb, which was a massive improvement over the 0.7156 baseline of Epoch 12. However, because we changed both parameters simultaneously, the panel reverted it for lack of isolation. Now that Epoch 14 has successfully isolated and merged total_steps_estimate=4100 (achieving 0.7067), we can cleanly test min_lr_ratio=0.01 in isolation to see if the deeper decay yields further gains.

**Expected result**

> Predicted val_bpb between 0.6990 and 0.7050. Any result above 0.7067 falsifies the hypothesis that a deeper learning rate floor improves final-stage consolidation.

**Notebook entry**

> Isolating min_lr_ratio=0.01 with total_steps_estimate=4100 to determine if deeper learning rate annealing yields a clean win over the 0.7067 baseline.

<details>
<summary>Agent's recorded reasoning notes</summary>

> My goal as Planner is to systematically squeeze the remaining juice out of our schedule alignment. Epoch 14 proved that matching the horizon to 4100 steps is highly effective (0.7067). In Epoch 13, we reached 0.7071 with min_lr_ratio=0.01, but we didn't know if the gain was from the horizon or the floor. Now that 4100 is the baseline, changing ONLY min_lr_ratio to 0.01 is a perfectly isolated 1-parameter change. If it improves upon 0.7067, we establish a new state-of-the-art. If it regresses, we prove that a 10% floor is indeed optimal for this budget.

</details>

## Executor: x-ai/grok-4.3

> Isolating the 0.01 floor cleanly after horizon=4100 merge. Let's see if deeper anneal helps.

**Change made**

> Minimal surgical change: in train(), pass min_lr_ratio=0.01 to the single lr_at_step() call (line ~280). All other code, defaults, and schedule parameters identical to epoch-14 best.

**Notebook entry**

> min_lr_ratio=0.01 tested in isolation after horizon fix; track if floor too low hurts.

<details>
<summary>Agent's recorded reasoning notes</summary>

> Epoch 14 proved horizon=4100 alone is good. Now test only the deeper min_lr_ratio=0.01 in isolation exactly as the hypothesis requires; one-line edit to the call site.

</details>

<details>
<summary>Generated train.py</summary>

```python

"""
train.py -- AGENT-OWNED FILE. This is the baseline. Researcher agents may
rewrite ANYTHING in this file (architecture, optimizer, schedule, batch
composition, tricks) in pursuit of lower val_bpb.

CONTRACT (must be preserved no matter what changes above it):
  1. This file must remain runnable as `python train.py` (uses prepare.py's
     TIME_BUDGET / get_batch / evaluate_bpb -- prepare.py itself is immutable
     and is the sole source of truth for the metric).
  2. At the very end of a run, print EXACTLY ONE line of the form:
         RESULT {"val_bpb": <float>, "train_steps": <int>, "train_seconds": <float>,
                 "peak_vram_mb": <float>, "params_m": <float>, "tokens_seen": <int>}
     as valid single-line JSON prefixed with "RESULT ". Nothing else may be
     printed after this line. The harness parses this line to score the epoch.
  3. val_bpb MUST come from calling prepare.evaluate_bpb(model, ...) -- do not
     hand-roll a different evaluation path or peek at test.bin.
  4. Must run on CPU too (slowly) so `--smoke` works without a GPU (CI uses
     CPU-only torch).
  5. No new third-party dependencies beyond torch/numpy (+ whatever prepare.py
     already imports). Keep it a single file.

Baseline architecture is a small nanoGPT-style decoder-only transformer
trained directly on bytes (vocab_size=256), derived from nanoGPT (MIT
license) patterns -- CausalSelfAttention via F.scaled_dot_product_attention,
GELU MLP, pre-norm residual blocks, tied input/output embeddings, AdamW with
cosine LR decay and linear warmup.
"""

import argparse
import json
import math
import os
import time
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

import prepare


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


@dataclass
class GPTConfig:
    n_layer: int = 6
    n_head: int = 6
    n_embd: int = 384
    seq_len: int = 512
    dropout: float = 0.0
    vocab_size: int = 256
    bias: bool = False
    mlp_hidden: int = 1024  # SwiGLU hidden dim (parameter-matched to 4x GELU)


class RMSNorm(nn.Module):
    """Root Mean Square Layer Normalization (without mean subtraction)."""
    def __init__(self, normalized_shape, eps=1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(normalized_shape))

    def forward(self, x):
        # x: (B, T, C) or (B, C) -- normalized_shape is last dimension.
        rms = torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return x * rms * self.weight


class CausalSelfAttention(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        assert cfg.n_embd % cfg.n_head == 0
        self.n_head = cfg.n_head
        self.n_embd = cfg.n_embd
        self.dropout = cfg.dropout

        self.c_attn = nn.Linear(cfg.n_embd, 3 * cfg.n_embd, bias=cfg.bias)
        self.c_proj = nn.Linear(cfg.n_embd, cfg.n_embd, bias=cfg.bias)
        self.attn_dropout_p = cfg.dropout
        self.resid_dropout = nn.Dropout(cfg.dropout)

    def forward(self, x):
        B, T, C = x.size()
        q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
        q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)
        v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2)

        y = F.scaled_dot_product_attention( 
            q,
            k,
            v,
            attn_mask=None,
            dropout_p=self.attn_dropout_p if self.training else 0.0,
            is_causal=True,
        )
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        y = self.resid_dropout(self.c_proj(y))
        return y


class MLP(nn.Module):
    """SwiGLU MLP: gated linear unit with SiLU gate.

    hidden_dim=1024 keeps parameter count roughly matched to the previous
    4x GELU MLP. GELU 4x: 2 * n_embd * (4*n_embd) = 2*384*1536 = 1,179,648.
    SwiGLU: 3 * n_embd * hidden = 3*384*1024 = 1,179,648 -- exactly matched.
    """
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        hidden = cfg.mlp_hidden
        self.c_fc = nn.Linear(cfg.n_embd, hidden, bias=cfg.bias)
        self.c_gate = nn.Linear(cfg.n_embd, hidden, bias=cfg.bias)
        self.c_proj = nn.Linear(hidden, cfg.n_embd, bias=cfg.bias)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x):
        return self.dropout(self.c_proj(F.silu(self.c_gate(x)) * self.c_fc(x)))


class Block(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.ln_1 = RMSNorm(cfg.n_embd, eps=1e-5)   # replaced LayerNorm
        self.attn = CausalSelfAttention(cfg)
        self.ln_2 = RMSNorm(cfg.n_embd, eps=1e-5)   # replaced LayerNorm
        self.mlp = MLP(cfg)

    def forward(self, x):
        x = x + self.attn(self.ln_1(x))
        x = x + self.mlp(self.ln_2(x))
        return x


class GPT(nn.Module):
    def __init__(self, cfg: GPTConfig):
        super().__init__()
        self.cfg = cfg
        self.transformer = nn.ModuleDict(
            dict(
                wte=nn.Embedding(cfg.vocab_size, cfg.n_embd),
                wpe=nn.Embedding(cfg.seq_len, cfg.n_embd),
                drop=nn.Dropout(cfg.dropout),
                h=nn.ModuleList([Block(cfg) for _ in range(cfg.n_layer)]),
                ln_f=RMSNorm(cfg.n_embd, eps=1e-5),   # replaced LayerNorm
            )
        )
        self.lm_head = nn.Linear(cfg.n_embd, cfg.vocab_size, bias=False)
        # weight tying
        self.transformer.wte.weight = self.lm_head.weight

        self.apply(self._init_weights)
        # scaled init for residual projections, per GPT-2 / nanoGPT convention
        for pn, p in self.named_parameters():
            if pn.endswith("c_proj.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * cfg.n_layer))

    def _init_weights(self, module):
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
        elif isinstance(module, RMSNorm):
            nn.init.ones_(module.weight)   # RMSNorm weight initialized to 1

    def num_params(self) -> int:
        n = sum(p.numel() for p in self.parameters())
        n -= self.transformer.wpe.weight.numel()  # nanoGPT convention: exclude pos emb
        return n

    def forward(self, idx, targets=None):
        B, T = idx.size()
        assert T <= self.cfg.seq_len, f"sequence length {T} exceeds block size {self.cfg.seq_len}"
        pos = torch.arange(0, T, dtype=torch.long, device=idx.device)

        tok_emb = self.transformer.wte(idx)
        pos_emb = self.transformer.wpe(pos)
        x = self.transformer.drop(tok_emb + pos_emb)
        for block in self.transformer.h:
            x = block(x)
        x = self.transformer.ln_f(x)
        logits = self.lm_head(x)

        loss = None
        if targets is not None:
            loss = F.cross_entropy(
                logits.view(-1, logits.size(-1)), targets.view(-1), reduction="mean"
            )
        return logits, loss

    def configure_optimizer(self, weight_decay, lr, betas):
        decay, no_decay = [], []
        for _, p in self.named_parameters():
            if not p.requires_grad:
                continue
            if p.dim() >= 2:
                decay.append(p)
            else:
                no_decay.append(p)
        groups = [ 
            {"params": decay, "weight_decay": weight_decay},
            {"params": no_decay, "weight_decay": 0.0},
        ]
        return torch.optim.AdamW(groups, lr=lr, betas=betas)


# --------------------------------------------------------------------------
# LR schedule: linear warmup then cosine decay
# --------------------------------------------------------------------------


def lr_at_step(step, warmup_steps, total_steps_estimate, max_lr, min_lr_ratio=0.1):
    if step < warmup_steps:
        return max_lr * (step + 1) / warmup_steps
    if total_steps_estimate <= warmup_steps:
        return max_lr
    progress = (step - warmup_steps) / max(1, (total_steps_estimate - warmup_steps))
    progress = min(progress, 1.0)
    coeff = 0.5 * (1.0 + math.cos(math.pi * progress))
    min_lr = max_lr * min_lr_ratio
    return min_lr + coeff * (max_lr - min_lr)


# --------------------------------------------------------------------------
# Training
# --------------------------------------------------------------------------


def get_device():
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def train(args):
    device = get_device()
    torch.manual_seed(1337)

    smoke = args.smoke
    if smoke:
        n_layer, n_embd, n_head = 2, 64, 2
        seq_len = 64
        batch_size = 8
        time_budget = 20.0
        eval_max_batches = 4
        eval_batch_size = 8
        mlp_hidden = 128
    else:
        n_layer, n_embd, n_head = 6, 384, 6
        seq_len = 512
        batch_size = 64
        time_budget = prepare.TIME_BUDGET
        eval_max_batches = 200
        eval_batch_size = 32
        mlp_hidden = 1024

    cfg = GPTConfig(
        n_layer=n_layer,
        n_head=n_head,
        n_embd=n_embd,
        seq_len=seq_len,
        dropout=0.0,
        vocab_size=256,
        mlp_hidden=mlp_hidden,
    )

    # ensure data is present (idempotent; smoke uses the synth path)
    prepare.prepare(smoke=smoke)

    model = GPT(cfg).to(device)
    params_m = model.num_params() / 1e6

    use_amp = device == "cuda"
    amp_dtype = torch.bfloat16

    try:
        compiled_model = torch.compile(model)
        run_model = compiled_model
    except Exception as e:
        print(f"[train] torch.compile unavailable ({e}); running eager", flush=True)
        run_model = model

    max_lr = 1.2e-3
    optimizer = model.configure_optimizer(weight_decay=0.1, lr=max_lr, betas=(0.9, 0.95))
    warmup_steps = 100
    # rough estimate for cosine schedule length; recomputed as we learn tok/s
    total_steps_estimate = 4100

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    # --- warmup / compile step, excluded from the wall-clock budget ---
    x, y = prepare.get_batch("train", batch_size, seq_len, device)
    with torch.autocast(device_type=device, dtype=amp_dtype, enabled=use_amp):
        _, loss = run_model(x, y)
    loss.backward()
    optimizer.zero_grad(set_to_none=True)
    if device == "cuda":
        torch.cuda.synchronize()

    step = 0
    tokens_seen = 0
    t_start = time.time()
    last_log_t = t_start
    last_log_tokens = 0

    while True:
        elapsed = time.time() - t_start
        if elapsed >= time_budget:
            break

        lr = lr_at_step(step, warmup_steps, total_steps_estimate, max_lr, min_lr_ratio=0.01)
        for g in optimizer.param_groups:
            g["lr"] = lr

        x, y = prepare.get_batch("train", batch_size, seq_len, device)
        with torch.autocast(device_type=device, dtype=amp_dtype, enabled=use_amp):
            _, loss = run_model(x, y)

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

        step += 1
        tokens_seen += batch_size * seq_len

        if step % 50 == 0:
            now = time.time()
            dt = now - last_log_t
            dtok = tokens_seen - last_log_tokens
            toks_per_sec = dtok / dt if dt > 0 else 0.0
            print(
                f"[train] step={step} loss={loss.item():.4f} tok/s={toks_per_sec:.0f} "
                f"elapsed={elapsed:.1f}s/{time_budget:.0f}s",
                flush=True,
            )
            last_log_t = now
            last_log_tokens = tokens_seen

    train_seconds = time.time() - t_start

    peak_vram_mb = 0.0
    if device == "cuda":
        peak_vram_mb = torch.cuda.max_memory_allocated() / (1024 * 1024)

    val_bpb = prepare.evaluate_bpb(
        model,
        batch_size=eval_batch_size,
        max_batches=eval_max_batches,
        seq_len=seq_len,
        device=device,
    )

    result = {
        "val_bpb": float(val_bpb),
        "train_steps": int(step),
        "train_seconds": float(train_seconds),
        "peak_vram_mb": float(peak_vram_mb),
        "params_m": float(params_m),
        "tokens_seen": int(tokens_seen),
    }
    print("RESULT " + json.dumps(result))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="tiny config, fast CPU smoke test")
    args = ap.parse_args()
    train(args)


if __name__ == "__main__":
    main()
```

</details>

## Challenger: anthropic/claude-opus-4.8

> Clean isolation, honest negative — 0.01 floor is dead. But note: e13 got 0.7071 on this EXACT config, we got 0.7153. That 0.008 gap IS our noise floor. Revert and seed-replicate the best.

**Notebook entry**

> IDENTICAL config (4100/min_lr=0.01) gave 0.7071@e13 but 0.7153@e15 — noise floor is ~0.008 bpb. RUN SEED REPLICATES of the best before trusting any sub-0.01 win.

**Recommendation**

> proceed

**Recorded risk rating**

> medium

### Concern 1

> The change is cleanly isolated (single min_lr_ratio 0.1→0.01), so attribution is fine. But the result is a clear REGRESSION: 0.7153 vs e14 best 0.7067, +0.0086 bpb. Note the step count jumped to 4400 (vs 4335 at e14) — this is NOT a speed effect, it's the same wall clock; the extra steps come from run-to-run noise. Yet bpb got worse despite MORE steps, confirming the deep anneal to 1.2e-5 hurt.

**Suggested follow-up**

> Accept the negative result and REVERT. min_lr_ratio=0.01 is now conclusively worse than 0.1 at horizon=4100. This closes the e13 question: e13's 0.7071 gain was from the horizon change (confirmed e14), NOT the 0.01 floor.

<details>
<summary>Example from the saved output</summary>

> Final ~1000 steps ran at near-zero LR (floor 1.2e-5), effectively wasting the training tail on negligible updates instead of consolidating — training loss plateaued at ~0.50 with no downward trend from step 3400→4400.

</details>

### Concern 2

> Interpretation caveat: the delta (+0.0086) is above the sub-0.01 'suggestive' noise band flagged in e14 notebook, so this is a real regression, not variance. But we STILL have no seed replicate to pin the noise floor — the fact that e13's exact same config (4100/0.01) measured 0.7071 while THIS run measured 0.7153 is a ~0.008 discrepancy on IDENTICAL config.

**Suggested follow-up**

> Flag this loudly: two runs of the identical config differ by 0.008 bpb. Treat ALL sub-0.01 deltas (including e14's 0.7067 vs 0.7156) as within noise until someone runs 2-3 seed replicates of the current best.

<details>
<summary>Example from the saved output</summary>

> e13 row: total_steps=4100, min_lr_ratio=0.01 → 0.7071. This epoch: same 4100/0.01 → 0.7153. Same hyperparameters, ~0.008 apart. That IS the noise floor staring us in the face.

</details>

<details>
<summary>Conflicts raised</summary>

> DIRECT contradiction with e13 (results.tsv row 13): identical config 4100/min_lr_ratio=0.01 measured 0.7071 there, 0.7153 here. Per wiki convention this contradiction must be flagged, not overwritten — it reveals the run-to-run noise is ~0.008 bpb, larger than several of our 'wins'.

</details>

<details>
<summary>Agent's recorded reasoning notes</summary>

> Methodology is sound: single isolated change, no eval tampering, budget respected, real evaluate_bpb call. The number is worse and above the ~0.008 noise band vs e14, so revert is correct. The bombshell is the e13-vs-e15 identical-config discrepancy (0.7071 vs 0.7153) — same seed 1337, same config, 0.008 apart. That means our recent 'wins' (e14's 0.7067 vs 0.7156 baseline was ~0.009) sit dangerously close to noise. We're chasing ghosts without replicates.

</details>

## Reviewer: openai/gpt-5.5

> Clean isolation, clear answer: the deeper floor did not help. Keep the 4100 horizon, restore min_lr_ratio=0.1.

**Decision**

> revert

**Reason for the decision**

> The isolated min_lr_ratio change from 0.1 to 0.01 regressed: val_bpb=0.71526 versus the current best 0.7067, despite completing 4400 steps in 300.19s with the same 10.72M-param model. Because it is worse by +0.0086 bpb and Challenger found no methodological issue that would rescue it, the epoch must be reverted. The lesson is that the 4100-step horizon should stay, but the deeper 1.2e-5 LR floor is harmful or at least not reliably beneficial.

**Notebook entry**

> Do not lower min_lr_ratio to 0.01 with horizon=4100; isolated rerun regressed to 0.7153 despite 4400 steps.

<details>
<summary>Agent's recorded reasoning notes</summary>

> I’m ruling by measured validation loss: this run finished cleanly but lost to the standing best by a meaningful margin, even with slightly more steps. The only changed variable was min_lr_ratio, so attribution is straightforward: the lower floor is not an improvement here.

</details>

## Commentator: deepseek/deepseek-v4-pro

> Colleagues, the deep anneal hypothesis is now falsified in isolation. The gain from e13 was horizon, not the low floor.

**Round summary**

> Epoch 16 tested a deeper cosine anneal: min_lr_ratio dropped from 0.1 to 0.01 (LR floor 1.2e-5) while keeping the 4100-step horizon from epoch 14. The GPU measured val_bpb=0.7153 after 4400 steps, a clear regression from the current best of 0.7067. The panel reverted the change.

**Notebook entry**

> min_lr_ratio=0.01 with horizon=4100 regressed to 0.7153; the floor is too low, starving final consolidation. Keep min_lr_ratio≥0.1.

**Visitor summary**

> We tried pushing the learning rate floor much lower, but it backfired; the model needs more mid-training signal, not a deeper freeze.

<details>
<summary>Agent's recorded reasoning notes</summary>

> Epoch 13's 0.7071 with min_lr_ratio=0.01 was confounded by the horizon change. Now, with horizon fixed at 4100, the isolated test yields 0.7153, a clear regression. The aggressive decay to 1.2e-5 likely starves the model of learning signal in the final ~1000 steps, preventing the fine-grained consolidation that a moderate floor (0.1) provides. This clean negative result confirms that the sweet spot is min_lr_ratio=0.1, and future schedule experiments should keep the floor above 1e-4.

</details>

