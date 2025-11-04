# Build stage
FROM node:lts AS build
WORKDIR /app

# Copy the package files and install first.
# That way, Docker can reuse the cached dependencies when
# the source code changes but not the dependencies themselves.
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM httpd:2.4 AS runtime
COPY --from=build /app/dist /usr/local/apache2/htdocs/
EXPOSE 80