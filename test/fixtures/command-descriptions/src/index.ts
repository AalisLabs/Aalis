import type { BoundCommands } from '../../../../packages/api-commands/src/index.js';
import { t } from './texts.js';

/** command-descriptions 守卫的夹具：用本包字典登记说明的指令，英文的第一句超过 48 列 */
export function register(commands: BoundCommands): void {
  commands.command('zz-brief', t('brief'));
  commands.command('zz-long', t('long'));
}
