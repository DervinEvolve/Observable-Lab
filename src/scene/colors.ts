// "Quiet Science" Color Palette
// Academic research lab: warm wood + brass + glass, instruments with patina

export const COLORS = {
  // Structure colors
  structure: {
    wood: 0x8b7355,
    woodDark: 0x6b5344,
    brass: 0xb5a642,
    brassPatina: 0x8a7d3a,
    glass: 0xe8e4d9,
    walls: 0xf5f2eb,
    floor: 0x5c4a3a,
    ceiling: 0xf0ebe3,
  },

  // State colors
  states: {
    healthy: 0x7cb342,
    working: 0xffb74d,
    blocked: 0xe57373,
    stable: 0x64b5f6,
  },

  // Model accent colors
  models: {
    gemini: 0x4285f4,   // Google - blue
    deepseek: 0x10a37f, // DeepSeek - green
    claude: 0xd97706,   // Anthropic - amber
    gpt: 0x412991,      // OpenAI - purple
    grok: 0x1da1f2,     // xAI - twitter blue
  },

  // Lighting colors
  lighting: {
    ambient: 0xfff8e7,
    sunWarm: 0xffd699,
    sunCool: 0xc4d4e0,
    lampGlow: 0xffcc66,
  },
} as const

// Role to station mapping
export const STATION_ROLES = [
  'planner',
  'executor',
  'reviewer',
  'challenger',
  'commentator',
] as const

export type StationRole = typeof STATION_ROLES[number]
