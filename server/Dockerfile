# The `event-fabric` build context is the sibling EventFabric checkout (see compose.yml),
# so the image builds EventFabric from source.
FROM node:24-alpine AS build
WORKDIR /event-fabric
COPY --from=event-fabric package.json package-lock.json tsconfig.json README.md ./
RUN npm ci
COPY --from=event-fabric src ./src
COPY --from=event-fabric docs ./docs
# Pack it like a published release, so peers such as amqplib resolve from the server.
RUN npm run build && npm pack --pack-destination /tmp
WORKDIR /billing/server
COPY package.json package-lock.json tsconfig.json eslint.config.js ./
# `file:../../event-fabric` links /event-fabric here; the final image gets the packed release.
RUN npm ci
COPY src ./src
# Fails the build when src/event-fabric.generated.ts is stale; `npm run types` refreshes it.
RUN npm run check && npm test && npm prune --omit=dev \
  && npm install --no-save --omit=dev /tmp/event-fabric-*.tgz

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /billing/server/package.json ./
COPY --from=build /billing/server/dist ./dist
COPY --from=build /billing/server/node_modules ./node_modules
USER node
EXPOSE 3000
# The Application starts from its own entry point; the CLI runs as `node_modules/event-fabric/dist/cli/main.js`.
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
