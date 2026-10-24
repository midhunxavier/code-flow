FROM node:22.23.4-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates git openssh-client python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@2.1.302 @openai/codex@0.162.1 \
    && npm cache clean --force \
    && git config --system --add safe.directory '*'

# The terminal and process-recovery helpers inspect foreground process groups with ps.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node backend /opt/codeflow/backend
COPY runner.cjs /opt/codeflow/runner.cjs
ENV HOME=/home/node CODEFLOW_HOME=/home/node/.codeflow CODEFLOW_DESKTOP_CONTAINER=1 PORT=4317 CODEFLOW_LAUNCHER=1
ENV PATH=/home/node/.local/bin:$PATH
WORKDIR /workspace
USER node
EXPOSE 4317
ENTRYPOINT ["node", "/opt/codeflow/runner.cjs"]
