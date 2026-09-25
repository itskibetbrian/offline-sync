FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl procps && rm -rf /var/lib/apt/lists/*
RUN ln -sf "$(command -v node)" /usr/local/bin/nodejs
# Harbor agent setup probes `command -v procps`, but procps is a package
# name (it ships ps/free/top; no binary is called procps), so the probe can
# never pass and setup falls back to a slow apt-get install. The package is
# already installed above; this shim satisfies the probe.
RUN printf '#!/bin/sh\nexec ps "$@"\n' > /usr/local/bin/procps && chmod +x /usr/local/bin/procps

WORKDIR /workspace

COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
