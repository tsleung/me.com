# me.com
Hello me

## Basic Scripts

### Development
```
cd ./webapp
npm run dev
```


### Deployment
```
cd ./webapp
rm -rf ../docs
npm run build
git commit --all ../docs
git push

```

Files to preserve from ../docs:
* CNAME
* .nojekyll




## Notes
- Require .nojekyll so deployed site folders with _<folder-namer> are pubic