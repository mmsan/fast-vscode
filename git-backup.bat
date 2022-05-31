cd /d %~dp0
git init
git add .
git commit -m "backup"
git remote add origin https://gitee.com/mmsan/scs.git
git push -u origin master
exit