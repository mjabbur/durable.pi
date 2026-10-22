# Imagem do agente. O container é a fronteira de segurança: o host só roda
# Docker e Tailscale (docs/ROADMAP.md).
FROM node:24-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build && npm prune --omit=dev

RUN useradd --create-home --uid 10001 agent
USER agent

WORKDIR /workspace
ENV DURABLE_PI_SESSION_DIR=/home/agent/.local/share/durable-pi/sessions
ENTRYPOINT ["node", "/app/bin/durable-pi.mjs"]
