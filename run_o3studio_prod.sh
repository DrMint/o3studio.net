rm -r dist
npm ci
npm run build
npm run preview -- --port 45332 --host