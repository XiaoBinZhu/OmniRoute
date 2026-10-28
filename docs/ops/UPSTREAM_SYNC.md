# 上游自动同步与 proc 部署（upstream-sync）

本仓库是 `diegosouzapw/OmniRoute` 的 fork，分支模型与上游不同，改动前先读本文。

## 分支模型

| 分支   | 用途               | 规则                                                                                                         |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `main` | 上游纯净镜像       | 只能由 `sync-upstream.mjs` 对齐到上游 `release/vX.Y.Z` tip；**禁止提交**（每次同步会 force-with-lease 重置） |
| `dev`  | 本地开发与上游合并 | 所有本地改动先提交到这里                                                                                     |
| `proc` | 部署分支           | 由 `promote-proc.mjs` 从 `dev` 合并；push 后触发 `.github/workflows/deploy-proc.yml`                         |

## 为什么默认分支是 dev

GitHub Actions 的 `schedule` 只在仓库**默认分支**的最新提交上求值。`main` 必须保持上游纯净镜像（每次同步都会被重置），不能放 workflow 文件，因此 fork 的默认分支已切换为 `dev`，`upstream-sync.yml` 只存在于 `dev`。

## 自动同步

- 调度：`0 20 * * 6`（UTC）= **每周日 04:00 北京时间**。
- 门禁：距上次 PROC 更新（`max(proc 最后提交时间, 最近一次 deploy-proc run)`）不足 **72h** 时本周跳过。
- 流程：`sync-upstream.mjs`（main 镜像 + merge upstream→dev）→ `promote-proc.mjs`（merge dev→proc）→ 显式 dispatch `deploy-proc`（`-f deploy=true -f build_web=true -f image_variant=web`）。
- 手动 push proc 或手动 dispatch deploy-proc 会重置 72h 计时（例如周六手动部署过，周日自动跳过）。
- `repair-deploy` job 在每次门禁运行时检查“proc 已前进但未成功部署”并自动补发（12h 内失败过或部署进行中则跳过）。
- 每次执行前会把 CI 的 `dev` fast-forward 到 fork 的最新 `dev`（本地运行时若本地 `dev` 与 fork 分叉——有未推送提交且远端也前进——会直接停止，绝不覆盖）。
- 冲突处理：Git 自动合并无冲突部分；真正冲突时 workflow 失败，**不推送 proc、不触发部署**，并在 Step Summary 与 GitHub Issue（标题 `[upstream-sync] 同步冲突 ...`）中列出冲突文件；下次成功同步后自动关闭该 Issue。

## 手动操作

```bash
# 本地演练 / 执行
npm run sync:upstream:dry
npm run sync:upstream
npm run sync:proc -- --dry-run

# 只检查门禁（不强制部署）
gh workflow run upstream-sync.yml --ref dev -R XiaoBinZhu/OmniRoute

# 立即同步并部署（忽略 72h 门禁）
gh workflow run upstream-sync.yml --ref dev -f force=true -R XiaoBinZhu/OmniRoute

# 暂停 / 恢复自动化
gh workflow disable upstream-sync -R XiaoBinZhu/OmniRoute
gh workflow enable upstream-sync -R XiaoBinZhu/OmniRoute
```

## 失败与回滚

- merge 冲突 / 推送被拒：workflow 失败，**不推送 proc、不部署**（main 可能已对齐上游，这是无害的镜像更新）；冲突文件会写进 Step Summary 并创建 Issue；用 `npm run sync:upstream:dry` 在本地复现后手工解决。
- 部署失败：`deploy-proc` 自带健康门禁与自动回滚（`scripts/ops/proc-deploy.sh`）。
- 回滚默认分支：`gh api -X PATCH repos/XiaoBinZhu/OmniRoute -f default_branch=main`。
- 回滚生产：见 `docs/ops/PROC_HEADLESS_DEPLOY.md` 的 rollback 段（`.proc-releases` 记录最近 3 个镜像）。

## 注意

- 不要使用 GitHub 的 “Sync fork” 按钮：默认分支已改为 `dev`，该按钮会把上游合并进 `dev`，绕过本流程的 72h 门禁与 proc 推进。
- `vars.DEPLOY_IMAGE_KIND`（当前 `web`）决定自动部署的镜像变体；改为 `core` 会部署无 dashboard 的 headless 镜像。
- `vars.DEPLOY_ENABLED` 必须为 `true`，否则 deploy job 会被跳过（此时 repair 的“已部署”判断不再准确）。
