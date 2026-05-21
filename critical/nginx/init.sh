sudo docker run -d --name=cdn --restart unless-stopped \
    -p 8081:80 \
    -v /mnt/cdn:/usr/share/nginx/html:ro \
    nginx