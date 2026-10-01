# Build with the Hypervibe repository root as context. Publishing records the
# resulting immutable digest; orchestration must never deploy these base tags
# or guess a helper digest from a tag.
FROM node:24-bookworm-slim AS build
WORKDIR /opt/hypervibe
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.build.json \
    && npm prune --omit=dev --ignore-scripts

FROM postgres:16-bookworm AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/hypervibe
COPY --from=build /opt/hypervibe/package.json ./package.json
COPY --from=build /opt/hypervibe/dist ./dist
COPY --from=build /opt/hypervibe/node_modules ./node_modules
USER postgres
ENTRYPOINT ["node", "/opt/hypervibe/dist/ci/backup-runner.js"]
