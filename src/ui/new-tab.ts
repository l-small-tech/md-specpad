/**
 * Executing a `NewTabChoice` — the one place a tab type becomes an action, so
 * the "+" button, the picker and the command palette take the same path.
 */

import { createDeck, createWhiteboard } from './session';
import { tabsStore } from './stores/tabs';
import { isAndroid } from './platform';
import { openTerminal } from './terminal-open';

export type NewTabChoice = 'note' | 'drawing' | 'deck' | 'terminal';

/** True where a terminal tab can exist at all (everywhere but Android). */
export function terminalsAvailable(): boolean {
  return !isAndroid();
}

export function runNewTabChoice(choice: NewTabChoice): void {
  switch (choice) {
    case 'terminal':
      openTerminal();
      return;
    case 'drawing':
      void createWhiteboard();
      return;
    case 'deck':
      void createDeck();
      return;
    case 'note':
      tabsStore.getState().newTab();
      return;
  }
}

/**
 * "+" with no modifier, and the "New tab" shortcut: always a new markdown
 * note in the notes folder, whatever tab is in front. Every other type is one
 * pick away in the "+ ⌄" picker.
 */
export function newTabDefault(): void {
  runNewTabChoice('note');
}
