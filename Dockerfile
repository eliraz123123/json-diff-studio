FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/app.db
COPY package.json ./
COPY *.js *.html *.css ./
COPY lib/ ./lib/
RUN rm -f ./*.test.js ./lib/*.test.js
# Runs as root because Fly.io volumes mount root-owned; the container holds nothing else.
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
