#!/usr/bin/env python3
"""
Serve BlueWeb, with the browser cache kept out of the way.

`python3 -m http.server` sends Last-Modified and nothing else. A response
carrying no Cache-Control is cached *heuristically*: the browser invents a
freshness lifetime of about a tenth of the file's age, and until that runs out
it will reuse what it has without so much as asking whether the file changed.
A page last touched three days ago is therefore good for the next nine hours.

For a static site being read, that is fine. For one being edited it is a trap,
and a quiet one -- you change a module, reload, and are shown the version from
before the change, with nothing anywhere saying that is what happened. The
conclusion it invites is that the edit did not work, which is the wrong thing
to go and debug.

So every response here says no-store. That is slower than it needs to be for
files coming off the same machine, and on a link this short nobody will notice.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        """no-store, rather than no-cache.

        no-cache still stores the response and revalidates it, which is enough
        for a file whose timestamp moved -- but not for one restored from a
        backup, or checked out with an older timestamp than the copy already
        held. no-store keeps nothing, so there is nothing to be wrong about.
        """
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p', '--port', type=int, default=8080)
    parser.add_argument('-b', '--bind', default='127.0.0.1',
                        help='address to listen on (default: localhost only)')
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f'BlueWeb on http://{args.bind}:{args.port}  (serving {ROOT})')
        print('Ctrl-C to stop.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == '__main__':
    main()
