# Build from the repository root. Only an independently published and observed
# immutable registry digest may be configured in Hypercloud; this local tag is
# not a deployment reference.
FROM node:24-slim
WORKDIR /opt/hypervibe-holding
COPY templates/cloud-holding/server.cjs ./server.cjs
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/opt/hypervibe-holding/server.cjs"]
