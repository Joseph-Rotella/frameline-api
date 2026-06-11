# Frameline API — container image for Render / Railway / Fly.io
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV PORT=4000
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/data/uploads
EXPOSE 4000
CMD ["npm", "start"]
