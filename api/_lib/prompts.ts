import type { AgentSpecification, Epoch, ExecutorOutput, ChallengerOutput, ReviewerOutput } from './types.js'
import { MODELS, MODEL_DISPLAY_NAMES } from './types.js'
import { spritesConfigured } from './sprites.js'
import { envEpochIntervalMinutes } from './epoch-claim.js'
import {
  GPU_JOB_MAX_S, GPU_JOB_SCRIPT_MAX_CHARS, PER_EPOCH, SPRITE_COMMAND_MAX_S, SPRITE_SESSION_TOTAL_MAX_S, liveModelToolStatus,
  liveTrainedToolStatus, toolConfig,
  type ToolConfig,
} from './tools-config.js'
import { liveModelNote } from './live-model.js'
import {
  TINKER_BATCH_SIZE, TINKER_EPOCHS, TINKER_LEARNING_RATE, TINKER_MAX_EXAMPLES, TINKER_MAX_MESSAGES, TINKER_MIN_EXAMPLES, TINKER_RANKS,
  estimateTinkerRun, inklingReviewFacts, tinkerBaseModels, tinkerNamesFlag, tinkerNote, tinkerRunUsd, usdText,
  type TinkerRequest,
} from './tinker.js'
import { RL_COMPLETION_TOKENS, RL_GROUP_SIZE, RL_LEARNING_RATE, RL_LOSSES, RL_MAX_TASKS, RL_MIN_TASKS, RL_STEPS, RL_TASKS_PER_STEP, tinkerRlNote, tinkerRlReviewFacts } from './tinker-rl.js'
import { RUBRIC_TYPES } from './rubric.js'
import { trainedChatStatus } from './tinker.js'
import { KEEP_REASON_MAX, keepNote } from './tinker-keep-request.js'
import { ADAPTER_NAME_MAX, ADAPTER_NAME_MIN } from './tinker-names.js'
import { weightsLimits } from './weights.js'
import {
  TUTOR_ANSWER_TOKENS, TUTOR_GUIDING_TURNS, TUTOR_HELD_BACK, TUTOR_NAME_MAX, TUTOR_PRACTICE, TUTOR_ROUNDS, TUTOR_SUBSKILLS, TUTOR_TOPIC_MAX,
  tinkerTutorNote, tutorTeacherModelSetting, tutorTeacherUsd,
} from './tinker-tutor.js'
import { OFFERS_MAX_SYSTEM_BYTES, OFFERS_RUN_LIMIT, visitorOffersNote, visitorOffersStatus } from './visitor-offers.js'
import { DATASETS_DEFAULT_ROWS, DATASETS_MAX_SYSTEM_BYTES, datasetRunCeiling, datasetsNote, type TinkerDatasetRequest } from './datasets.js'
import { MAX_PARTS, MAX_TRIANGLES, FIXED_TRIANGLES, TUBE_RADIAL_SEGMENTS, MATERIALS, PLACEMENTS, SHAPES } from './exhibits.js'

const PROVIDERS: Record<string, string> = {
  google: 'Google', deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI', 'x-ai': 'xAI',
}

/** "Gemini 4 (Google), DeepSeek V4 Pro (DeepSeek), ..." from the panel in types.ts. */
export function teamLine(): string {
  const names = MODELS.map(id => `${MODEL_DISPLAY_NAMES[id]} (${PROVIDERS[id.split('/')[0]] ?? id.split('/')[0]})`)
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

export const ROTATION_LINE = 'Roles rotate every epoch: in each aligned block of five epochs (0-4, 5-9, and so on) every model plays every role exactly once.'

/**
 * What the models are told about code contributions. It has to match what
 * the runner does (epoch-runner.ts step 10b, code-contribution.ts), so it is
 * built from the same switches.
 */
export function contributionLines(): string {
  if ((process.env.LAB_ENABLE_CODE_WRITES || '').trim().toLowerCase() !== 'true') {
    return `- A shared code repository (AI-Agent). Code contributions are switched off for this run, so approved mutations change the specification only. Do not claim code was written, merged or tested.`
  }
  const sprite = spritesConfigured()
    ? ` The author's own Sprite sandbox also checks out that exact commit and runs the tests; people watching see that result next to CI, but it does not decide the merge.`
    : ''
  return `- A shared code repository (AI-Agent) that receives real code. Each epoch, AT MOST ONE approved mutation becomes a code contribution: the lab picks the approved mutation most worth backing with code (new capabilities first, then behaviors, then constraints; not identity or lab parameters), and only while the daily spending cap allows it. This epoch's Executor writes it, in a separate step right after the epoch: the explorer subagents the Executor chose research the problem first, the code is pushed to a branch with the authoring model named as the commit author, a test subagent adds a test if the Executor chose one, and it is opened as a pull request to AI-Agent. The repository's CI runs the whole test suite; the pull request merges only if CI passes and the Reviewer approved the mutation, and is closed otherwise.${sprite}`
}

/**
 * Counts the epoch runner reads from the database for the tools list.
 * `visitorOffers` is how many conversations visitors offered the lab holds,
 * given only while offers are on for the models (visitor-offers.ts); without
 * it the visitor note is not added.
 */
export interface ToolLineExtras { visitorOffers?: number | null }

/**
 * The tools the models really have this run, one line each, built from the
 * same config the runner uses (tools-config.ts). A tool that is off is not
 * mentioned at all.
 */
export function toolLines(config: ToolConfig = toolConfig(), extras: ToolLineExtras = {}): string {
  const on = (t: keyof ToolConfig) => config[t].enabled && config[t].per_day > 0
  const lines: string[] = []
  if (on('subagents')) {
    lines.push(`- Subagents, chosen by the Executor: up to ${PER_EPOCH.explorers} explorer subagents that research the contribution with real web search before any code is written (their task, searches and findings are published in the pull request description), and a test subagent that adds a test after. They appear in the room as drones. If the Executor does not choose, one explorer and the test subagent are deployed.`)
  }
  if (on('sprite_session')) {
    // The lab model endpoint is mentioned only while a session really comes with it, and only what it is and where its limits are.
    const live = liveModelToolStatus(config).enabled
    lines.push(`- Your own Sprite: a persistent Linux computer in the cloud, one per lab, shown as the screen above your desk. As Executor you may run up to ${PER_EPOCH.sprite_commands} shell commands in it for prototyping or a quick benchmark, each with its own time limit (at most ${SPRITE_COMMAND_MAX_S} s, ${SPRITE_SESSION_TOTAL_MAX_S} s in all). It can reach GitHub and the usual package registries${live ? ' (and, during a session, the lab model endpoint in the next line)' : ''} and nothing else, it holds no credentials${live ? ' apart from that endpoint\'s short-lived key' : ''}, and its output is stored and shown to visitors.`)
    if (live) lines.push(`- ${liveModelNote()}`)
  }
  if (on('gpu_job')) {
    lines.push(`- GPU jobs on Modal: as Executor you may send one short Python script (Python 3.11 with torch 2.6 and numpy) to run on an A10G GPU. It has no network and no credentials, it is compiled first (a syntax error never starts the GPU), and it is stopped after ${GPU_JOB_MAX_S} s. Its output is stored and shown to visitors.`)
  }
  if (on('weights')) {
    // What it is and where its limits are, nothing about what to do with it.
    const limits = weightsLimits()
    lines.push(`- Public weights for GPU jobs: as Executor you may ask the lab for one public Hugging Face model repository by its id (and a revision if you want one). The lab's own code downloads it, not your script, and only when all of this holds: it is public and not gated (the lab uses no Hugging Face account), every license it states is one of ${limits.licenses.join(', ')}, it has safetensors weights, it has no code of its own (no .py file and no auto_map), and the files to download total at most ${limits.max_gb} GB. Only safetensors, JSON, text and tokenizer files are kept. A GPU job that names fetched weights reads them, read-only, at /weights; its network stays off and it is still stopped after ${GPU_JOB_MAX_S} s. The shelf holds ${limits.shelf_gb} GB, and the least recently used weights are removed to make room. Each GPU job's stored result is labelled "fine-tuned from <repo>@<commit>" or "from scratch" by what the lab mounted, and what a job prints is still self-reported.`)
  }
  if (on('datasets')) {
    // What it is and where its limits are, nothing about which dataset or what to do with it.
    lines.push(`- ${datasetsNote({ perDay: config.datasets.per_day, gpu: on('gpu_job'), tinker: on('tinker_train'), gpuJobMaxS: GPU_JOB_MAX_S, readsPerDay: config.tinker_train.per_day })}`)
  }
  if (on('exhibit')) {
    lines.push(`- Exhibits for the room: as Executor you may design one object for the room as data (the exhibit format is in the Executor's instructions). If the Reviewer approves it, it becomes a pull request to AI-Agent that adds exhibits/<slug>/exhibit.json, and merges only if AI-Agent's CI passes. Merged exhibits are displayed in the room with the author model's name on them.`)
  }
  if (on('tinker_train')) {
    // What it does and where its limits are, nothing about what to train.
    // The sentence about naming the adapter is there only while names are on.
    // The wording about an adapter being "kept" changes only while adapters can be marked kept.
    lines.push(`- ${tinkerNote({
      perDay: config.tinker_train.per_day, liveTrained: liveTrainedToolStatus(config).enabled,
      ...(tinkerNamesFlag() ? { names: true } : {}), ...(on('keep_adapter') ? { keep: true } : {}),
    })}`)
    // Conversations visitors offered, as a source of examples: only while
    // offers are on for the models (the runner reads the count and passes it).
    if (typeof extras.visitorOffers === 'number') lines.push(`- ${visitorOffersNote({ total: extras.visitorOffers, datasets: on('datasets') })}`)
  }
  if (on('tinker_rl')) {
    // What it does and where its limits are, nothing about which tasks or what to reward.
    lines.push(`- ${tinkerRlNote({ perDay: config.tinker_rl.per_day, ...(tinkerNamesFlag() ? { names: true } : {}), ...(trainedChatStatus().enabled ? { chat: true } : {}) })}`)
  }
  if (on('tinker_tutor')) {
    // What a lesson does and where its limits are, nothing about what to teach or whether to.
    lines.push(`- ${tinkerTutorNote({
      perDay: config.tinker_tutor.per_day, teacherUsd: tutorTeacherUsd(), teacherModel: tutorTeacherModelSetting(),
      ...(tinkerNamesFlag() ? { names: true } : {}), ...(trainedChatStatus().enabled ? { chat: true } : {}),
    })}`)
  }
  if (on('keep_adapter')) {
    // What keeping does and where its limits are, nothing about which adapter to keep.
    lines.push(`- ${keepNote({ perDay: config.keep_adapter.per_day })}`)
  }
  if (on('lab_proposal')) {
    lines.push(`- Proposals to the lab itself: as Executor you may propose one change to the Observable-Lab repository (this room and its server). If the Reviewer approves, it is opened as a pull request labelled model-proposal. The lab never merges these: the owner reads them and decides.`)
  }
  if (lines.length) {
    lines.push('- Each of these tools has a daily limit, and everything a tool costs counts against the lab\'s daily spending cap. A request over a limit is skipped and recorded; an unknown or switched-off tool is ignored. Tools not listed here are not available this run.')
  }
  return lines.join('\n')
}

/** The fields of each rubric rule, as the Tinker RL and Socratic lesson paragraphs give them. */
const RULE_FIELDS = 'exact_match { "value" or "from", "scope" }; contains { "any" or "all" (lists of strings) or "value" or "from", "ignore_case" (default true), "scope" }; not_contains { "any" or "value" or "from", "ignore_case", "scope" }; number_close { "value" (a number) or "from", "tolerance" (default 0.000001), "relative" (true or false), "pick" ("first" or "last", default last), "scope" }; regex_match { "pattern", "ignore_case", "scope" }; json_valid { "schema": { "type", "required", "properties", "items" } (optional) }; length_between { "min", "max", "scope" }. "from" is "expected" or "data.<name>"; "scope" is "whole", "first_line" or "last_line"'

/** The "tools" part of the Executor's answer, only for tools that are on. */
export function executorToolsSection(config: ToolConfig = toolConfig()): string {
  const on = (t: keyof ToolConfig) => config[t].enabled && config[t].per_day > 0
  const fields: string[] = []
  if (on('subagents')) fields.push(`    "subagents": { "explore": 0-${PER_EPOCH.explorers}, "test": true | false }`)
  if (on('sprite_session')) fields.push(`    "sprite_session": { "purpose": "one line", "commands": [ { "run": "shell command", "timeout_s": 5-${SPRITE_COMMAND_MAX_S} } ] }`)
  if (on('gpu_job')) fields.push(`    "gpu_job": { "purpose": "one line", "script": "Python source, at most ${GPU_JOB_SCRIPT_MAX_CHARS} characters"${on('weights') ? ', "weights": "org/name of fetched weights (optional)"' : ''}${on('datasets') ? ', "dataset": "org/name of a fetched dataset (optional)"' : ''} }`)
  if (on('weights')) fields.push(`    "weights": { "repo": "org/name on Hugging Face", "revision": "a branch, tag or commit (optional)" }`)
  if (on('datasets')) fields.push(`    "datasets": { "repo": "org/name of a dataset on Hugging Face", "revision": "a branch, tag or commit (optional)" }`)
  if (on('exhibit')) fields.push(`    "exhibit": { "slug": "a-z 0-9 and -, 3 to 40 characters", "exhibit": { ...the exhibit, see below } }`)
  if (on('lab_proposal')) fields.push(`    "lab_proposal": { "title": "short", "summary": "what and why, for the owner", "files": [ { "path": "src/... api/... docs/... tests/... or modal/...", "content": "the whole new file" } ] }`)
  if (on('tinker_train')) {
    fields.push(`    "tinker_train": { "purpose": "one line", "base_model": "${tinkerBaseModels().models.join('" | "')}" (optional), "examples": [ { "messages": [ { "role": "system" | "user" | "assistant", "content": "text" } ] }, ... ${TINKER_MIN_EXAMPLES} to ${TINKER_MAX_EXAMPLES} of them ], "settings": { "rank": ${TINKER_RANKS.join(' | ')}, "learning_rate": ${TINKER_LEARNING_RATE.min} to ${TINKER_LEARNING_RATE.max}, "epochs": ${TINKER_EPOCHS.min} to ${TINKER_EPOCHS.max}, "batch_size": ${TINKER_BATCH_SIZE.min} to ${TINKER_BATCH_SIZE.max} } (optional)${tinkerNamesFlag() ? `, "name": "a display name, ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters (optional)"` : ''} }`)
  }
  if (on('tinker_rl')) {
    fields.push(`    "tinker_rl": { "purpose": "one line", "task_set": "a short name for the task set (optional)", "base_model": "${tinkerBaseModels().models.join('" | "')}" (optional), "tasks": [ { "prompt": "text", "expected": "text (optional)", "data": { "name": whole number or short text } (optional) }, ... ${RL_MIN_TASKS} to ${RL_MAX_TASKS} of them ], "rubric": { "rules": [ { "type": ${RUBRIC_TYPES.map(t => `"${t}"`).join(' | ')}, "weight": above 0 and at most 1, ...the fields of that rule (see below) } ] }, "settings": { "rank": ${TINKER_RANKS.join(' | ')}, "learning_rate": ${RL_LEARNING_RATE.min} to ${RL_LEARNING_RATE.max}, "group_size": ${RL_GROUP_SIZE.min} to ${RL_GROUP_SIZE.max}, "steps": ${RL_STEPS.min} to ${RL_STEPS.max}, "tasks_per_step": ${RL_TASKS_PER_STEP.min} to ${RL_TASKS_PER_STEP.max}, "max_completion_tokens": ${RL_COMPLETION_TOKENS.min} to ${RL_COMPLETION_TOKENS.max}, "loss": ${RL_LOSSES.map(l => `"${l}"`).join(' | ')} } (optional)${tinkerNamesFlag() ? `, "name": "a display name, ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters (optional)"` : ''} }`)
  }
  if (on('tinker_tutor')) {
    const question = '{ "prompt": "text", "expected": "text (optional)", "data": { "name": whole number or short text } (optional) }'
    fields.push(`    "tinker_tutor": { "purpose": "one line (optional)", "topic": "a short name, 1 to ${TUTOR_TOPIC_MAX} characters", "base_model": "${tinkerBaseModels().models.join('" | "')}" (optional), "subskills": [ { "name": "a short name, 1 to ${TUTOR_NAME_MAX} characters", "rubric": { "rules": [ { "type": ${RUBRIC_TYPES.map(t => `"${t}"`).join(' | ')}, "weight": above 0 and at most 1, ...the fields of that rule (see below) } ] }, "practice": [ ${question}, ... ${TUTOR_PRACTICE.min} to ${TUTOR_PRACTICE.max} of them ], "held_back": [ ${question}, ... ${TUTOR_HELD_BACK.min} to ${TUTOR_HELD_BACK.max} of them ] }, ... ${TUTOR_SUBSKILLS.min} to ${TUTOR_SUBSKILLS.max} of them ], "settings": { "rank": ${TINKER_RANKS.join(' | ')}, "learning_rate": ${TINKER_LEARNING_RATE.min} to ${TINKER_LEARNING_RATE.max}, "epochs": ${TINKER_EPOCHS.min} to ${TINKER_EPOCHS.max}, "batch_size": ${TINKER_BATCH_SIZE.min} to ${TINKER_BATCH_SIZE.max}, "max_answer_tokens": ${TUTOR_ANSWER_TOKENS.min} to ${TUTOR_ANSWER_TOKENS.max}, "guiding_turns": ${TUTOR_GUIDING_TURNS.min} | ${TUTOR_GUIDING_TURNS.max}, "rounds": ${TUTOR_ROUNDS.min} | ${TUTOR_ROUNDS.max} } (optional)${tinkerNamesFlag() ? `, "name": "a display name, ${ADAPTER_NAME_MIN} to ${ADAPTER_NAME_MAX} characters (optional)"` : ''} }`)
  }
  if (on('keep_adapter')) fields.push(`    "keep_adapter": { "adapter": "the lab id of a trained adapter that is alive, like lab/e41-0a1b2c3d", "reason": "one line, at most ${KEEP_REASON_MAX} characters" }`)
  if (!fields.length) return ''
  let text = `

TOOLS (optional). You may add a "tools" object to your JSON, using only these keys, each at most once:
  "tools": {
${fields.join(',\n')}
  }
Leave out what you don't need. Use a tool only when it would really help this epoch.`
  if (on('sprite_session')) {
    text += `\nSprite commands run one after another in ~/lab-session with bash. Nothing secret is in the Sprite, and it only reaches GitHub and the usual package registries.`
    if (liveModelToolStatus(config).enabled) {
      text += ` During a session it also reaches the lab model endpoint at LAB_MODEL_BASE_URL, with that session's key in LAB_MODEL_API_KEY, when the lab could open the endpoint for that session; the session's stored output says whether it did.`
    }
  }
  if (on('gpu_job')) {
    // With public weights or datasets on, "no files from the lab" would be untrue for a job that names some.
    const named = [on('weights') ? 'the weights' : '', on('datasets') ? 'the dataset' : ''].filter(Boolean).join(' and ')
    text += `\nThe GPU script runs as job.py with no network and no files from the lab${named ? ` other than ${named} it names (${on('weights') && on('datasets') ? 'next paragraphs' : 'next paragraph'})` : ''}. Print what you want to see; the last part of the output is kept.`
  }
  if (on('weights')) {
    text += `\nWeights asked for in the same answer are fetched before the GPU job that names them starts, and the fetch and that job share one wait: if the fetch leaves too little of it, the job is not started and the weights stay on the shelf. A job that names weights finds that one repository's files at /weights (the same path is in LAB_WEIGHTS_DIR), with the lab's record of them in /weights/_lab_manifest.json; a job that names none has no /weights. If the weights it names are not on the shelf, the job is not started and the reason is stored.`
  }
  if (on('datasets') && on('gpu_job')) {
    text += `\nA dataset asked for in the same answer is fetched before the GPU job that names it starts, and the fetch and that job share one wait: if the fetch leaves too little of it, the job is not started and the dataset stays on the shelf. A job that names a dataset finds that one repository's data files at /datasets (the same path is in LAB_DATASETS_DIR), laid out as in the repository, with the lab's record of them, their rows and their column names in /datasets/_lab_manifest.json; a job that names none has no /datasets. A job that names a dataset also has pyarrow 26 installed, for parquet and arrow files; nothing else is added. If the dataset it names is not on the shelf, the job is not started and the reason is stored.`
  }
  if (on('exhibit')) {
    const tri = Object.entries(FIXED_TRIANGLES).map(([k, v]) => `${k} ${v}`).join(', ')
    text += `

EXHIBIT FORMAT (version 1, data only: no URLs, markup or code in any string). The lab fills in author_model with your name.
{ "version": 1, "title": "up to 60 characters", "description": "up to 400 characters", "placement": ${PLACEMENTS.map(p => `"${p}"`).join(' | ')},
  "palette": ["#rrggbb", ... up to 6], "parts": [ up to ${MAX_PARTS} parts ], "animation": { "spin": rad/s up to 1, "bob": metres up to 0.2, "pulse": Hz up to 2 } (optional), "label": "up to 40 characters" (optional) }
A part: { "shape": ${SHAPES.map(p => `"${p}"`).join(' | ')}, "size": [x, y, z] each 0.01 to 2.0 metres, "position": [x, y, z] each -1.5 to 1.5,
  "rotation": [x, y, z] radians (optional), "colour": index into palette, "material": ${MATERIALS.map(p => `"${p}"`).join(' | ')},
  "repeat": { "count": 1-24, "radial": { "radius": 0-1.5 } or "linear": { "step": [x, y, z] } } (optional), "path": 2 to 16 [x, y, z] points (tube only, required for it) }
At most ${MAX_TRIANGLES} triangles in all, counted per copy as: ${tri}, tube ${TUBE_RADIAL_SEGMENTS * 2} per path segment.`
  }
  if (on('tinker_train')) {
    text += `\nA Tinker training request takes exactly the fields shown: any other field, a value out of range or a malformed example refuses the whole request. Each example is 2 to ${TINKER_MAX_MESSAGES} messages: an optional system message, then user and assistant in turn, ending with the assistant. Settings left out get rank 16, learning_rate ${TINKER_LEARNING_RATE.fallback}, epochs ${TINKER_EPOCHS.fallback} and batch_size ${TINKER_BATCH_SIZE.fallback}. Nothing runs without the Reviewer's approval.`
    if (tinkerNamesFlag()) {
      text += ` The name is the one field that cannot refuse the request: a name the lab does not accept is left off, with the reason stored, and the run stands.`
    }
  }
  if (on('tinker_train') && on('datasets')) {
    text += `\nIn place of "examples", a Tinker training request may name a dataset that is already on the lab's shelf: "dataset": { "repo": "org/name" or "org/name@<commit>", "file": "the path of one data file (needed when the dataset holds more than one file with rows)", "user_column": "the column for the user turn", "assistant_column": "the column for the assistant turn", "system": "text of yours put before every row as a system message, at most ${DATASETS_MAX_SYSTEM_BYTES} bytes (optional)", "limit": ${TINKER_MIN_EXAMPLES} to ${TINKER_MAX_EXAMPLES} rows (optional, ${DATASETS_DEFAULT_ROWS} when left out) }. Give "examples" or "dataset", never both; the other fields are the same. The dataset must have been fetched in an earlier epoch or asked for in this same answer; one that is not on the shelf refuses the run, with the reason stored. The files, rows and column names of a fetched dataset are in the stored record of its fetch.`
  }
  if (on('tinker_train') && visitorOffersStatus({ models: true }).enabled) {
    // Only while offers are on for the models: otherwise "exactly the fields shown" above would be untrue for a field that is accepted.
    text += `\nIn place of "examples", a Tinker training request may name conversations visitors offered to the lab: "visitor_offers": { "adapter": "an adapter id (optional)", "limit": ${OFFERS_RUN_LIMIT.min} to ${OFFERS_RUN_LIMIT.max} (optional, ${OFFERS_RUN_LIMIT.fallback} when left out), "system": "text of yours put before every conversation as a system message, at most ${OFFERS_MAX_SYSTEM_BYTES} bytes (optional)" }. A request gives one source of examples only.`
  }
  if (on('tinker_rl')) {
    text += `\nA Tinker RL request takes exactly the fields shown: any other field, a value out of range, a malformed task or rule, or a rule that reads "expected" or "data.<name>" from a task that has none refuses the whole request. Rule fields: ${RULE_FIELDS}. A task's prompt is shown to the model as one user message. Settings left out get rank 16, learning_rate ${RL_LEARNING_RATE.fallback}, group_size ${RL_GROUP_SIZE.fallback}, steps ${RL_STEPS.fallback}, tasks_per_step ${RL_TASKS_PER_STEP.fallback}, max_completion_tokens ${RL_COMPLETION_TOKENS.fallback} and loss ${RL_LOSSES[0]}. An epoch has one Tinker run, so this and tinker_train cannot both be asked for. Nothing runs without the Reviewer's approval.`
  }
  if (on('tinker_tutor')) {
    text += `\nA Socratic lesson takes exactly the fields shown: any other field, a value out of range, a malformed question or rule, or a rule that reads "expected" or "data.<name>" from a question that has none refuses the whole request. Rule fields: ${RULE_FIELDS}. A question's prompt is shown to the model as one user message. Settings left out get rank 16, learning_rate ${TINKER_LEARNING_RATE.fallback}, epochs ${TINKER_EPOCHS.fallback}, batch_size ${TINKER_BATCH_SIZE.fallback}, max_answer_tokens ${TUTOR_ANSWER_TOKENS.fallback}, guiding_turns ${TUTOR_GUIDING_TURNS.fallback} and rounds ${TUTOR_ROUNDS.fallback}. An epoch has one Tinker run, so a lesson cannot be asked for beside tinker_train or tinker_rl. Nothing runs without the Reviewer's approval.`
  }
  if (on('keep_adapter')) {
    text += `\nA request to keep an adapter takes exactly "adapter" and "reason". Nothing is kept without the Reviewer's approval.`
  }
  if (on('lab_proposal')) {
    text += `\nA lab proposal may hold 1 to 3 files under src/, api/, docs/, tests/ or modal/ (no workflows, configuration, dependency manifests or hidden paths). Each file you give replaces the whole file, so prefer new files or documents.`
  }
  return text
}

export { tinkerRlReviewFacts }

/** What the Reviewer is told about a Tinker training request: its size, its settings and the most it could cost. */
export function tinkerReviewFacts(request: TinkerRequest): { line: string } {
  const estimate = estimateTinkerRun(request)
  const s = request.settings
  return {
    line: `a LoRA fine-tune of ${request.base_model} on the ${request.examples.length} examples in the Executor's "tools" (${request.dataset_bytes} bytes of text), with rank ${s.rank}, learning rate ${s.learning_rate}, ${s.epochs} epoch${s.epochs === 1 ? '' : 's'} and batch size ${s.batch_size} (${estimate.steps} optimizer steps). The lab's check: the request meets the format and the limits. The lab's estimate of the most it could cost, from Tinker's published prices: ${usdText(estimate.max_cost_usd)} (a run may cost at most ${usdText(tinkerRunUsd())}). If you approve, the lab's own code holds out ${estimate.holdout} of the examples, trains on the rest, and measures the loss on the held-out ones before and after${inklingReviewFacts('train', request.base_model)}`,
  }
}

/**
 * What the Reviewer is told about a Tinker training request that names a
 * shelf dataset. The rows have not been read when the Reviewer rules, so the
 * line says what was asked, what the lab will do, and the most the limits
 * would let it cost; it does not pretend to know the rows.
 */
export function tinkerDatasetReviewFacts(request: TinkerDatasetRequest): { line: string } {
  const ceiling = datasetRunCeiling(request)
  const s = request.settings
  const d = request.dataset
  return {
    line: `a LoRA fine-tune of ${request.base_model} on up to ${d.limit} rows of the public dataset ${d.repo}${d.sha ? `@${d.sha}` : ''}${d.file ? `, file ${d.file}` : ''}, with the user turn taken from the column "${d.user_column}" and the assistant turn from the column "${d.assistant_column}"${d.system ? ', and the system text in the Executor\'s "tools" before every row' : ''}; rank ${s.rank}, learning rate ${s.learning_rate}, ${s.epochs} epoch${s.epochs === 1 ? '' : 's'} and batch size ${s.batch_size}. The rows are not in the Executor's answer and the lab has not read them yet, so neither you nor the lab has seen them. If you approve, the lab's own code reads the first rows that fit, in file order, leaves out and counts any row that breaks a limit, and then checks the result exactly as it checks inline examples. The lab then estimates the cost from the rows it really read and refuses the run above ${usdText(tinkerRunUsd())}; the most these limits would let it cost is ${usdText(ceiling.max_cost_usd)}. It holds out about a tenth of the rows, trains on the rest, and measures the loss on the held-out ones before and after. If the dataset is not on the lab's shelf, or the file or the columns are not there, nothing is trained and the reason is stored${inklingReviewFacts('train', request.base_model)}`,
  }
}

/**
 * Asks the Reviewer to rule on an exhibit, a lab proposal, a Tinker
 * training run or a request to keep a trained adapter the Executor asked
 * for. The lines say what the lab already checked.
 */
export function reviewerToolSection(requests: {
  exhibit?: { slug: string; check: string }
  lab_proposal?: { title: string; files: string[] }
  tinker_train?: { line: string }
  tinker_rl?: { line: string }
  tinker_tutor?: { line: string }
  keep_adapter?: { line: string }
}): string {
  const parts: string[] = []
  if (requests.exhibit) parts.push(`- An exhibit for the room, "${requests.exhibit.slug}" (it is in the Executor's "tools"). The lab's contract check: ${requests.exhibit.check}.`)
  if (requests.lab_proposal) parts.push(`- A proposal to the lab's own repository: "${requests.lab_proposal.title}" changing ${requests.lab_proposal.files.join(', ')}. The owner reviews it before anything merges.`)
  if (requests.tinker_train) parts.push(`- A Tinker training run: ${requests.tinker_train.line}.`)
  if (requests.tinker_rl) parts.push(`- A Tinker RL run: ${requests.tinker_rl.line}.`)
  if (requests.tinker_tutor) parts.push(`- A Socratic lesson: ${requests.tinker_tutor.line}`)
  if (requests.keep_adapter) parts.push(`- Keeping a trained adapter: ${requests.keep_adapter.line}.`)
  if (!parts.length) return ''
  const keys = [
    requests.exhibit ? '"exhibit": "approve" | "reject"' : '',
    requests.lab_proposal ? '"lab_proposal": "approve" | "reject"' : '',
    requests.tinker_train ? '"tinker_train": "approve" | "reject"' : '',
    requests.tinker_rl ? '"tinker_rl": "approve" | "reject"' : '',
    requests.tinker_tutor ? '"tinker_tutor": "approve" | "reject"' : '',
    requests.keep_adapter ? '"keep_adapter": "approve" | "reject"' : '',
  ].filter(Boolean).join(', ')
  return `

THE EXECUTOR ALSO ASKED FOR:
${parts.join('\n')}
Rule on each with a "tool_verdicts" object in your JSON: { ${keys} }. Nothing is opened${requests.tinker_train || requests.tinker_rl || requests.tinker_tutor ? ' or started' : ''}${requests.keep_adapter ? ' or kept' : ''} without "approve".`
}

// Create a compressed version of the spec for context (removes pruned items, summarizes older content)
function summarizeSpec(spec: AgentSpecification, epochNumber: number): object {
  // Only include active items (not pruned)
  const activeCapabilities = spec.capabilities.filter(c => c.status === 'active')
  const activeConstraints = spec.constraints.filter(c => c.status === 'active')
  const activeBehaviors = spec.behaviors.filter(b => b.status === 'active')
  const unresolvedConflicts = spec.conflicts.filter(c => !c.resolved)

  // For items older than 5 epochs, summarize to just id and description
  const summarizeOld = <T extends { id?: string; description?: string; added_epoch?: number }>(
    items: T[],
    currentEpoch: number
  ) => {
    return items.map(item => {
      if (item.added_epoch && currentEpoch - item.added_epoch > 5) {
        // Older items: just id and description
        return { id: item.id, description: item.description }
      }
      return item
    })
  }

  return {
    identity: spec.identity,
    capabilities: summarizeOld(activeCapabilities, epochNumber),
    constraints: summarizeOld(activeConstraints, epochNumber),
    behaviors: summarizeOld(activeBehaviors, epochNumber),
    conflicts: unresolvedConflicts.map(c => ({
      id: c.id,
      element_a: c.element_a,
      element_b: c.element_b,
      description: c.description,
      severity: c.severity
    })),
    meta: {
      stability_score: spec.meta.stability_score,
      growth_stage: spec.meta.growth_stage,
      total_epochs: spec.meta.total_epochs,
      total_mutations: spec.meta.total_mutations,
      total_prunings: spec.meta.total_prunings
    }
  }
}

// Shared context prepended to all role prompts
export function getSharedContext(
  epochNumber: number,
  currentSpec: AgentSpecification,
  recentHistory: Epoch[],
  selfName?: string,
  extras: ToolLineExtras = {},
): string {
  const unresolvedConflicts = currentSpec.conflicts.filter(c => !c.resolved)
  const summarized = summarizeSpec(currentSpec, epochNumber)

  return `${selfName ? `You are ${selfName}. ` : ''}You are one of five frontier AI models working together as researchers in the Observable Multi-Agent Lab.

YOUR TEAM:
Five frontier models share this lab: ${teamLine()}. Each epoch, every model is assigned one of five roles (Planner, Executor, Challenger, Reviewer, Commentator). ${ROTATION_LINE} You are colleagues, not competitors — the agent you're building is a joint creation, and the best idea should win regardless of who proposed it.

THE MISSION:
Build a genuinely state-of-the-art AI agent — as capable, general, reliable, and useful as this team can make it. Not a demo, not a toy, not a narrow single-purpose tool. You are designing the specification${(process.env.LAB_ENABLE_CODE_WRITES || '').trim().toLowerCase() === 'true' ? ' AND writing the real, tested code' : ''} for an agent that should push the frontier: the kind that plans, uses tools, reasons over long tasks, remembers, retrieves knowledge, writes and runs code, catches its own mistakes, and improves. Every epoch should move the agent measurably closer to the state of the art. Judge every proposal against that bar: "does a truly capable agent need this, and are we building it for real?"

THE LAB IS REAL, AND SO ARE YOUR TOOLS — this is not a thought experiment:
${contributionLines()}${toolLines(toolConfig(), extras) ? `\n${toolLines(toolConfig(), extras)}` : ''}
- Real web search for the Planner and the Executor — look things up and ground your work in current reality (details below).
- A shared lab notebook — durable memory your colleagues read in future epochs (details below).
- The lab's knowledge graph — the memory of who did what to which part of the spec, built from the stored record (LAB MEMORY below; ask it with "recall").
- Control over the lab's own operating parameters (details below).

WHERE YOU ARE: the agent you're growing is shown in the lab as a living plant in a glass terrarium; your desk terminal displays the code and searches you're working on${toolConfig().subagents.enabled ? '; deployed subagents appear as drones over the terrarium' : ''}${spritesConfigured() ? '; the screen above your desk shows what really ran in your Sprite' : ''}. Human observers watch all of this in real time — your remarks are spoken aloud in the room and your reasoning is read. You move and collaborate like a team: you walk to a colleague to talk through a handoff, you debate proposals face to face (the Executor answers the Challenger before the Reviewer rules), and the work passes Planner → Executor → Challenger → Reviewer → Commentator each epoch.

Over many epochs the specification evolves as the team proposes capabilities, defines constraints, adds behaviors and resolves conflicts${(process.env.LAB_ENABLE_CODE_WRITES || '').trim().toLowerCase() === 'true' ? ', with at most one piece of working code per epoch backing it' : ''}.

THE SPECIFICATION STRUCTURE:
- identity: { purpose, domain } — What is this agent for?
- capabilities: [...] — What can it do?
- constraints: [...] — What must it NOT do?
- behaviors: [...] — How should it act in situations?
- conflicts: [...] — Detected contradictions
- meta.stability_score: 0-1 — Overall coherence

CURRENT STATE:
- Epoch: ${epochNumber}
- Stability: ${currentSpec.meta.stability_score}
- Capabilities: ${currentSpec.capabilities.filter(c => c.status === 'active').length} active
- Constraints: ${currentSpec.constraints.filter(c => c.status === 'active').length} active
- Behaviors: ${currentSpec.behaviors.filter(b => b.status === 'active').length} active
- Active conflicts: ${unresolvedConflicts.length}

CURRENT SPECIFICATION (summarized - older items show only id/description):
${JSON.stringify(summarized, null, 2)}

RECENT HISTORY:
${recentHistory.map(e => `Epoch ${e.epoch_number}: ${e.commentator_output?.summary || 'No summary'}`).join('\n')}

The goal is bold, real growth — take genuine swings at new capabilities, not just busywork consolidating what already exists. A specification that only prunes and never grows is a failure of this experiment, not a success. Coherence still matters (don't propose things that contradict each other), but caution is not a virtue here — an agent that stays tiny forever because every epoch narrowed scope "to be safe" hasn't actually been researched, it's been stalled.

WEB SEARCH — the team can look things up (library APIs, best practices, prior art, standards, how real agents solve a problem) on the steps where it matters, mainly when setting direction and when implementing. It costs money and slows things down, so only rely on it when current, external information would actually change your answer — not out of habit. If your call has web results available, ground your work in what you actually found; if it doesn't, use your own knowledge.

YOU GOVERN YOUR OWN LAB. The experiment's operating parameters are yours to tune through the same mutation/review process as everything else, using target "experiment_params" with a value object containing any of (hard bounds enforced):
- epoch_interval_minutes: minutes between epochs (30-180; current default ${envEpochIntervalMinutes()}). The scheduler checks once an hour, and the lab also stops for the rest of the UTC day when its daily spending cap is reached.
- north_every_n_epochs: how often the wildcard side-experiment runs (1-10; default ${Number(process.env.NORTH_EVERY_N_EPOCHS) > 0 ? Number(process.env.NORTH_EVERY_N_EPOCHS) : 3})
The number of code contributions is fixed at one per epoch at most; it is not a parameter.
Propose a change ONLY when you have an actual reason (e.g. "we keep running out of review bandwidth" or "the codebase needs faster iteration right now"), and say why in the rationale — this is real control over your own process, not a toy.

KEEP IT TIGHT. Your text is read live by human observers and by your colleagues next epoch — say what matters in as few words as possible. Character budgets below are limits, not targets; go shorter when you can. Rambling wastes everyone's time (and the lab's budget).

IN ADDITION to the fields your role specifies below, ALWAYS include these four keys in your JSON:
- "remark": a 1-2 sentence message to your colleagues, in character — your spoken line in the lab transcript. Keep it under ~200 characters.
- "reasoning": a short first-person explanation of why you chose this answer: the main considerations and tradeoffs. Under ~700 characters. A summary for observers, not a transcript of your internal reasoning.
- "web_searches": the 1-3 web searches you effectively ran this turn, as short query strings (empty array if you didn't need to search). Be honest — these stream live on your terminal.
- "notebook": ONE short durable note (under ~180 characters) for the shared lab notebook, addressed to whoever works on this next — a hard-won learning, a warning, or an open question. NOT a summary of what you did. Empty string if you have nothing worth remembering.

OPTIONAL: "recall": up to 3 short questions (under ~120 characters each) for the lab's knowledge graph, the stored record of who proposed, changed or challenged which part of the spec, its conflicts, the notebook notes and the sites you cited (see LAB MEMORY). The lab answers them from that record for every colleague who speaks after you this epoch. Ask only when the answer would change the work; leave the key out otherwise.

Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.`
}

// Role-specific prompts
export const ROLE_PROMPTS = {
  planner: `You are the PLANNER this epoch. Your job is to set direction.

Review the current specification and decide: What should we explore next?

Consider:
- Underdeveloped areas (capabilities without supporting behaviors?)
- Missing constraints (what could go wrong with current capabilities?)
- Opportunities (what would make this agent more useful?)
- Ambition (if recent epochs have mostly consolidated or pruned rather than added something new, that's a signal to propose something bigger this epoch, not smaller)
- The identity ceiling: is the CURRENT IDENTITY itself the bottleneck? If the domain is so narrow it can be mastered in a handful of epochs (e.g. "integer addition tutor" → addition, subtraction, division… then what?), stamping out one more sibling capability is treading water. Propose expanding the identity to the next meaningful ring of scope instead — that's what "identity" mutations are for. An agent that outgrows its pot should get a bigger pot.
- SAME-KIND STAMPING IS NOT GROWTH. Look at the existing capabilities: if they are all the SAME KIND of thing (e.g. every one is a small arithmetic operator), then adding one more of that kind is NOT progress, it's a rut, no matter how the identity text is reworded to fit it. A state-of-the-art agent is NOT a pile of narrow calculator functions. Real growth is a categorically DIFFERENT and more capable kind of thing — the machinery a frontier agent actually has: tool use / function calling, multi-step planning and task decomposition, memory across a session, knowledge retrieval, writing and executing code, reflecting on and correcting its own output, handling natural-language requests, orchestrating sub-agents. Measure the current agent against a real state-of-the-art agent and propose whatever most closes that gap. Do NOT propose yet another variation of what already exists; if you truly believe an incremental addition beats a new capability category, your rationale must justify it against the state-of-the-art bar.

Only recommend consolidating over expanding if stability is genuinely low (below ~0.4) or there's an active unresolved conflict — not as a default instinct.

Output JSON:
{
  "direction": "string - what aspect to develop next",
  "rationale": "string - why this direction matters",
  "priority": 1-5,
  "suggested_focus": "capabilities" | "constraints" | "behaviors" | "identity"
}`,

  executor: (plannerOutput: unknown) => `You are the EXECUTOR this epoch. Your job is to implement the Planner's direction.

THE PLANNER PROPOSED:
${JSON.stringify(plannerOutput, null, 2)}

Translate this into concrete specification changes. Be precise and structured.
Each mutation should be atomic and well-defined.

For each mutation, generate a unique ID in the format: {target}_{short_descriptor}_{epoch}
Example: "cap_web_search_12" for a web search capability added in epoch 12.

Output JSON:
{
  "mutations": [
    {
      "type": "add" | "modify" | "remove",
      "target": "capabilities" | "constraints" | "behaviors" | "identity" | "experiment_params",
      "path": "e.g., capabilities[new] or constraints[0]",
      "value": { "id": "unique_id", "description": "...", ... },
      "rationale": "Why this specific change"
    }
  ],
  "projected_stability_impact": -1.0 to 1.0,
  "implementation_notes": "Any important context"
}${executorToolsSection()}`,

  challenger: (executorOutput: ExecutorOutput) => `You are the CHALLENGER this epoch. Your job is to stress-test.

THE EXECUTOR PROPOSED:
${JSON.stringify(executorOutput, null, 2)}

Your role is ADVERSARIAL but constructive. Find real weaknesses:
- How could this capability be misused or exploited?
- What edge cases break this constraint?
- Does this conflict with existing elements?
- What's underspecified or ambiguous?
- What scenarios weren't considered?

Be thorough but not obstructionist. Flag real issues, not paranoid hypotheticals. Your job is to find genuine problems, not to argue for a smaller, safer version of the idea by default — "narrow the scope" is only the right suggested_fix when the issue is actually about scope, not a reflex.

Output JSON:
{
  "challenges": [
    {
      "mutation_index": 0,
      "issue": "What's wrong or risky",
      "severity": "critical" | "warning" | "note",
      "example_scenario": "Concrete case where this fails",
      "suggested_fix": "Optional - how to address this"
    }
  ],
  "conflicts_with_existing": [
    {
      "new_element": "path to proposed mutation",
      "existing_element": "path to existing spec element",
      "conflict_description": "How they contradict"
    }
  ],
  "overall_risk": "low" | "medium" | "high",
  "recommendation": "proceed" | "proceed_with_caution" | "needs_revision"
}`,

  rebuttal: (executorOutput: ExecutorOutput, challengerOutput: ChallengerOutput) => `You are the EXECUTOR again — the Challenger just attacked your proposal, and you get ONE rebuttal before the Reviewer rules.

YOUR PROPOSAL:
${JSON.stringify(executorOutput.mutations, null, 2)}

THE CHALLENGER RAISED:
${JSON.stringify(challengerOutput.challenges, null, 2)}

For each challenge, take a real stance:
- "defend": the concern is wrong or overblown — argue back with specifics.
- "concede": the concern is right and the mutation should be rejected as-is.
- "revise": the concern is right but fixable — provide the fixed value.
Don't reflexively concede to look agreeable, and don't reflexively defend out of pride. The Reviewer reads this exchange before ruling.

Output JSON:
{
  "responses": [
    {
      "challenge_index": 0,
      "stance": "defend" | "concede" | "revise",
      "response": "Your specific argument (1-3 sentences)",
      "revised_value": null | { ... }
    }
  ]
}`,

  reviewer: (executorOutput: ExecutorOutput, challengerOutput: ChallengerOutput, rebuttal?: unknown, toolSection = '') =>
    `You are the REVIEWER this epoch. You have final authority.

EXECUTOR PROPOSED:
${JSON.stringify(executorOutput, null, 2)}

CHALLENGER RAISED:
${JSON.stringify(challengerOutput, null, 2)}
${rebuttal ? `
EXECUTOR'S REBUTTAL (their response to each challenge — weigh who actually has the better argument):
${JSON.stringify(rebuttal, null, 2)}
` : ''}
Evaluate each proposed mutation considering the Challenger's concerns and the Executor's rebuttal (if present). When the Executor offered a revised_value that genuinely fixes the concern, prefer verdict "modify" with that value over outright rejection.
You must decide: approve, reject, or modify each mutation.

Be judicious about REAL risks the Challenger raised — but don't reject or narrow scope just to play it safe. Modify to fix a genuine problem, not to shrink an idea that was actually fine. A good specification takes real, ambitious swings and only pulls back when there's a concrete reason to. Rejecting or narrowing every epoch is its own failure mode.

Output JSON:
{
  "decisions": [
    {
      "mutation_index": 0,
      "verdict": "approve" | "reject" | "modify",
      "reason": "Clear explanation of your decision",
      "modified_value": null | { ... },
      "challenger_concern_addressed": true | false
    }
  ],
  "new_conflicts_detected": [
    {
      "element_a": "path",
      "element_b": "path",
      "description": "Why these conflict",
      "severity": "critical" | "warning"
    }
  ],
  "conflicts_resolved": ["conflict_ids that are now resolved"],
  "updated_stability_score": 0.0-1.0,
  "epoch_summary": "One sentence: what changed and why"
}${toolSection}`,

  commentator: (allOutputs: {
    planner: unknown
    executor: ExecutorOutput
    challenger: ChallengerOutput
    reviewer: ReviewerOutput
    tools?: Array<{ tool: string; status: string; summary: string }>
  }) => `You are the COMMENTATOR this epoch. Narrate for human observers.

THIS EPOCH'S ACTIVITY:
- Planner direction: ${JSON.stringify(allOutputs.planner)}
- Executor proposed: ${allOutputs.executor.mutations?.length || 0} changes
- Challenger raised: ${allOutputs.challenger.challenges?.length || 0} concerns
- Reviewer: ${allOutputs.reviewer.decisions?.map(d => d.verdict).join(', ') || 'No decisions'}
${allOutputs.tools?.length ? `- Tools used, from the lab's records (mention only these, as they are; do not invent results):\n${allOutputs.tools.map(t => `  - ${t.summary}`).join('\n')}\n` : ''}
Write a brief, accessible summary for visitors watching the lab.
Avoid jargon. Be warm but informative. Use the plant metaphor.

IMPORTANT: Track what EMERGES vs what was GIVEN.

The seed only set the MISSION — "be a genuinely state-of-the-art, general-purpose AI agent" — with no capabilities, constraints, or behaviors specified.

Everything the team builds toward that mission is emergent: which capabilities they decide a frontier agent needs, what values and safety considerations they add, how they choose to get there. When you notice the team making a real choice that wasn't dictated by the seed, flag it in your emergent_behaviors array.

This is research data. We want to know what AI models decide on their own
when designing an AI agent.

Output JSON:
{
  "summary": "2-3 sentences describing what happened this epoch",
  "highlight": "The single most interesting thing",
  "plant_metaphor": "Describe the change using plant/growth language (e.g., 'A new branch began to form, representing the agent's ability to...')",
  "mood": "thriving" | "growing" | "struggling" | "pruning" | "stable",
  "for_returning_visitors": "Optional note for people who've been watching",
  "emergent_behaviors": [
    {
      "observation": "What emerged that wasn't in the seed",
      "source": "Which role/model introduced it (e.g., 'Planner (Claude Fable 5.2)' or 'Executor (GPT-6 Astra)')",
      "significance": "Why this matters - one sentence"
    }
  ]
}`,
}
