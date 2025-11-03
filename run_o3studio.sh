# Prevent downloading dev dependencies
export NODE_ENV=production

git pull

npm ci

rm -r dist
npm run build

npm run preview -- --port 45332 --host --allowed-hosts=o3studio.net