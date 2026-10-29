import { defineLocale } from '@aalis/schema-i18n';
import type { Source } from '../texts.js';

export default defineLocale<Source>()({
  displayName: 'Skills (Agent Skills)',
  skillsUriLabel: 'Skill storage URI',
  skillsUriDescription:
    'Storage URI of the skills folder (skills:/ by default, i.e. self/skills in the home directory). Each skill is a subdirectory containing SKILL.md.',
  badSkillsUri: 'skillsUri must be a storage URI',
  maxSkillBytesLabel: 'Max bytes per skill',
  maxSkillBytesDescription:
    'Maximum size of a single SKILL.md in bytes, so loading too much at once does not pollute the context.',
  maxSkillsLabel: 'Max number of skills',
  maxSkillsDescription: 'Maximum number of skills loaded per scan.',
  discoveryEnabledLabel: 'Enable discovery injection',
  discoveryEnabledDescription:
    'Inject a line pointing to the skill library into the system prompt, telling the agent to search with list_skills and load with load_skill; turning it off also stops injecting the bodies of activated skills.',
  triggersEnabledLabel: 'Enable trigger-based activation',
  triggersEnabledDescription: 'Load a skill automatically when the triggers regex in its SKILL.md frontmatter matches.',
  skills: 'Skills',
  delete: 'Delete',
  deleteConfirm: "Delete this skill's whole directory (including scripts, references and assets)?",
  skillMissing: 'Skill {name} does not exist',
  deleted: 'Deleted skill {name}',
  deleteDirFailed: 'Failed to delete the skill directory {uri}: {error}',
  noSkills: 'No skills yet',
  name: 'Name',
  description: 'Description',
  triggers: 'Triggers',
  files: 'Attached files',
  fileCounts: 'Scripts {scripts, number} / References {references, number} / Assets {assets, number}',
  list: '{items, list}',
  license: 'License',
  location: 'Location',
  scripts: 'Scripts',
  references: 'References',
  assets: 'Assets',
  body: 'SKILL.md body',
  groupLabel: 'Skill management',
  groupSummary:
    'Query, load, create, update and delete reusable Agent Skills (compatible with the Anthropic SKILL.md standard)',
  enabledLabel: 'Enabled skills',
  enabledDescription:
    'Which skills this session can use: * means all skills, an empty list enables none. Listing, loading, the skill library hint and trigger-based activation only see the enabled ones',
  allSkills: 'All skills',
});
