// Conventional Roblox child names — when a script does
// `inst:WaitForChild("Cash")`, default to `IntValue` rather than the
// honest fallback `Instance`. Heuristic but stable: the 127-script
// corpus uses these conventionally.

export const CONVENTIONAL_CHILDREN: Record<string, string> = {
  // Player containers (these classes have specific members; narrowing
  // beyond Instance unlocks them).
  PlayerGui: 'PlayerGui',
  Backpack: 'Backpack',
  StarterGear: 'StarterGear',
  PlayerScripts: 'PlayerScripts',
  // Note: `leaderstats` intentionally absent — most scripts access
  // `leaderstats.Cash` (dynamic child) directly, and narrowing to Folder
  // would surface TS2339 for those accesses. Use the WaitForChild
  // signature's default `Instance` return instead.
  // Common leaderstat numeric values
  Cash: 'IntValue',
  Kills: 'IntValue',
  Deaths: 'IntValue',
  Trolls: 'IntValue',
  Wins: 'IntValue',
  Losses: 'IntValue',
  Level: 'IntValue',
  XP: 'IntValue',
  Exp: 'IntValue',
  Score: 'IntValue',
  Money: 'IntValue',
  Coins: 'IntValue',
  Gems: 'IntValue',
  Diamonds: 'IntValue',
  Rebirth: 'IntValue',
  Rebirths: 'IntValue',
  Points: 'IntValue',
  Stage: 'IntValue',
  TimeElapsed: 'IntValue',
  TimesJoined: 'IntValue',
  // Character members
  Humanoid: 'Humanoid',
  HumanoidRootPart: 'Part',
  Head: 'Part',
  Torso: 'Part',
  UpperTorso: 'Part',
  LowerTorso: 'Part',
  // Common services-ish
  ReplicatedStorage: 'ReplicatedStorage',
  ServerStorage: 'ServerStorage',
  Workspace: 'Workspace',
};
