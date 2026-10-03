FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
