#!/bin/bash
# Double-click in Finder to start Reading Path and open it in your browser.
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:8765" ) &
exec python3 server.py
