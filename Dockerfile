# 1. Use the official Microsoft Playwright image (has all Linux UI libraries)
FROM mcr.microsoft.com/playwright:v1.62.1-jammy
# 2. Set the working directory inside the container
WORKDIR /app

# 3. Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# 4. Copy the rest of your API code
COPY . .

# 5. Expose the port Azure expects
EXPOSE 8080

# 6. Boot the server
CMD ["node", "server.js"]