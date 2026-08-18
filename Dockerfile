# 1. Use the official Node.js image based on Debian
FROM node:20-bookworm

# 2. Set the working directory inside the server
WORKDIR /workspace

# 3. Copy package.json and install Node modules
COPY package*.json ./
RUN npm install

# 4. Install Chromium AND all required Linux OS dependencies
RUN npx playwright install --with-deps chromium

# 5. Copy the rest of your backend code
COPY . .

# 6. Expose the port your Express app runs on (usually 8080 or 3000)
EXPOSE 8080

# 7. Start the server
CMD ["npm", "start"]