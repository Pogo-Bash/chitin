# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# The Chitin relay as an image people run themselves (relay/README.md: you are the operator).
#
#   docker build -t chitin-relay relay/
#   docker run --rm -p 127.0.0.1:8101:8101 chitin-relay --origin http://localhost:8100   # demo hosts only; see RELAY_HOSTS below
#
# Plain ws:// on port 8101; for wss:// put a reverse proxy with a certificate in front, or mount a
# certificate and pass --tls-cert/--tls-key. The process listens on one port and opens outgoing
# connections only. No dependencies beyond Python's standard library.
FROM python:3.12-slim
RUN useradd --system --no-create-home --shell /usr/sbin/nologin relay
COPY relay.py /relay/relay.py
COPY README.md /relay/README.md
USER relay
EXPOSE 8101
# Deny by default: the demo's hosts only. Override with -e RELAY_HOSTS=a.example,*.b.example (names and
# *.suffix wildcards); the relay refuses to start with an empty list. Opening it to the whole internet
# takes an explicit -e RELAY_ALLOW_ANY_HOST=1, and is your responsibility (docs/operators.md).
ENV RELAY_BIND=0.0.0.0 RELAY_PORT=8101 RELAY_HOSTS="en.wikipedia.org,*.wikipedia.org,*.wikimedia.org,docs.python.org,text.npr.org"
ENTRYPOINT ["python3", "/relay/relay.py"]
