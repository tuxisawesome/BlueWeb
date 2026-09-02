/* Every test, in one place, so tests.html has one script tag. */

import { run } from './harness.js';

import './version.test.js';
import './tifile.test.js';
import './blueidx.test.js';
import './actions.test.js';
import './deps.test.js';
import './install.test.js';

run();
