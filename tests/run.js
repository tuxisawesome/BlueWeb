/* Every test, in one place, so tests.html has one script tag. */

import { run } from './harness.js';

import './version.test.js';
import './lock.test.js';
import './log.test.js';
import './progress.test.js';
import './tifile.test.js';
import './link.test.js';
import './catalog.test.js';
import './blueidx.test.js';
import './actions.test.js';
import './deps.test.js';
import './install.test.js';
import './backup.test.js';

run();
