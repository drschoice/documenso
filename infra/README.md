# Deploying Documenso to AWS ECS Express Mode

This runs the Documenso fork on **Amazon ECS Express Mode** — a managed way to run a container on
Fargate where ECS provisions and operates the load balancer, an **HTTPS endpoint + URL**, target
groups, security groups, and auto-scaling for you. A GitHub Action builds the image, pushes it to
**ECR**, and rolls it out with `update-express-gateway-service` on every push to **`production`**.
Auth uses **GitHub OIDC** (no long-lived AWS keys).

Why Express Mode (vs a hand-built ALB, or App Runner): managed HTTPS/URL out of the box, **always-on
Fargate CPU** so Documenso's in-process cron sweeps keep running (App Runner would starve them), one
ALB shared across up to 25 services (cheaper as you add tenants), and it's AWS's supported path
forward (App Runner is sunset).

| File | What it is |
| --- | --- |
| [`ecs-stack.yml`](./ecs-stack.yml) | CloudFormation: ECR, IAM roles (task execution, task, **Express infrastructure role**, GitHub deploy role), log group, secret shell |
| [`../.aws/primary-container.json`](../.aws/primary-container.json) | The container spec (image + env + the 26 Secrets Manager secrets) Express Mode runs |
| [`./put-secrets.sh`](./put-secrets.sh) | Loads `.env.prod` + `cert.p12` into Secrets Manager |
| [`../.github/workflows/deploy-ecs.yml`](../.github/workflows/deploy-ecs.yml) | Build → push to ECR → `update-express-gateway-service` |

**Ownership model:** CloudFormation manages only static infra. The **Express service** is created once
with `aws ecs create-express-gateway-service` and thereafter updated by the pipeline — CFN never
touches it, so no drift.

---

## Phase 0 — VPC facts (already inspected for this account)

| Item | Value |
| --- | --- |
| Region / Account | `us-east-1` / `<ACCOUNT_ID>` |
| VPC | `<VPC_ID>` |
| Public subnets (give these to Express → internet-facing ALB + public-IP tasks) | `<PUBLIC_SUBNET_1A>`, `<PUBLIC_SUBNET_1B>`, `<PUBLIC_SUBNET_1C>` |
| DB access SG (attach to the service; Aurora already trusts it) | `<RDS_CLIENT_SG>` (`ec2-rds-2`) |
| GitHub OIDC provider (reuse) | `arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com` |

> Express Mode couples subnet type to ALB scheme: **public** subnets → internet-facing ALB + tasks get
> public IPs (needed so external signers can reach the app; the private Aurora DB is still reached over
> the VPC's internal network via the `ec2-rds-2` SG). Private subnets would give an *internal* ALB, which
> signers couldn't reach.

---

## Phase 1 — Create static infra (CloudFormation)

```bash
export AWS_REGION=us-east-1
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name documenso-infra \
  --template-file infra/ecs-stack.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      GitHubOrg=drschoice GitHubRepo=documenso DeployBranch=production \
      ExistingOidcProviderArn=arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com

aws cloudformation describe-stacks --region us-east-1 --stack-name documenso-infra \
  --query 'Stacks[0].Outputs' --output table
```

Note these outputs: `EcrRepositoryUri`, `TaskExecutionRoleArn`, `TaskRoleArn`, `InfrastructureRoleArn`,
`GitHubDeployRoleArn`, `AppSecretArn`.

---

## Phase 2 — Populate the secret from `.env.prod`

Make sure `.env.prod` has your real RDS URL first:

```
NEXT_PRIVATE_DATABASE_URL="postgres://<DB_USER>:<PASSWORD>@<AURORA_WRITER_ENDPOINT>:5432/<DB_NAME>?sslmode=require"
```

Then load everything (reads `.env.prod` + `cert.p12`, base64s the cert, checks all keys the
primary-container needs exist, writes to Secrets Manager):

```bash
export AWS_REGION=us-east-1
./infra/put-secrets.sh                 # defaults: .env.prod, cert.p12, documenso/app
```

---

## Phase 3 — Store account-specific values as GitHub Actions secrets

This repo is public, so nothing account-specific is committed. `.aws/primary-container.json` keeps the
`REPLACE_WITH_AppSecretArn` and image placeholders; the workflow reads the real ARNs from **repository
secrets** (Settings → Secrets and variables → Actions) and substitutes them at deploy time.

```bash
gh secret set AWS_DEPLOY_ROLE_ARN --repo drschoice/documenso --body "<GitHubDeployRoleArn output>"
gh secret set APP_SECRET_ARN      --repo drschoice/documenso --body "<AppSecretArn output>"
# ECS_SERVICE_ARN is set in Phase 5, once the service exists (until then the rollout step self-skips).
```

---

## Phase 4 — Build the first image and create the Express service

Express Mode needs an image to launch, so push one first (requires Docker locally; builds amd64):

```bash
REG=$(aws ecr describe-repositories --region us-east-1 --repository-names documenso \
  --query 'repositories[0].repositoryUri' --output text)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REG%/*}"
docker build -f docker/Dockerfile -t "$REG:bootstrap" .
docker push "$REG:bootstrap"
```

Create the service (Fargate 2 vCPU / 4 GB, min 1 task, health check `/api/health`, public subnets +
the `ec2-rds-2` SG). It prints the service ARN and a `https://…on.aws` URL:

```bash
aws ecs create-express-gateway-service \
  --region us-east-1 \
  --service-name documenso \
  --execution-role-arn <TaskExecutionRoleArn> \
  --infrastructure-role-arn <InfrastructureRoleArn> \
  --task-role-arn <TaskRoleArn> \
  --cpu 2048 --memory 4096 \
  --health-check-path /api/health \
  --scaling-target '{"minTaskCount":1,"maxTaskCount":4,"autoScalingMetric":"AVERAGE_CPU","autoScalingTargetValue":60}' \
  --network-configuration '{"subnets":["<PUBLIC_SUBNET_1A>","<PUBLIC_SUBNET_1B>","<PUBLIC_SUBNET_1C>"],"securityGroups":["<RDS_CLIENT_SG>"]}' \
  --primary-container "$(sed 's|REPLACE_WITH_AppSecretArn|<AppSecretArn output>|g' .aws/primary-container.json | jq --arg img "$REG:bootstrap" '.image=$img')" \
  --monitor-resources DEPLOYMENT
```

> `--cpu`/`--memory` take **Fargate units** (CPU units + MiB), not vCPU/GB — `2048`/`4096` = 2 vCPU / 4 GB.
> (The AWS getting-started doc's `--cpu 2 --memory 4` example is misleading and is rejected as an invalid
> combination.) The `sed` injects the real secret ARN locally just for this one-time create — it is not
> committed.

Record the **service ARN** and the **application URL** from the output.

> **Verify at this point:** the service reaches `ACTIVE` and targets go healthy. Because we passed a
> custom SG, confirm two things: (1) the ALB can still reach the tasks on 3000 (health checks pass — if
> not, Express's managed service SG handling needs the container port, which it sets automatically), and
> (2) the app connected to Aurora (the log shows migrations run, not hang). Watch logs with
> `aws logs tail /ecs/documenso --region us-east-1 --follow`.

---

## Phase 5 — Point the app at its real URL, wire the pipeline, deploy

1. Set `NEXT_PUBLIC_WEBAPP_URL` in `.env.prod` to the Express URL from Phase 4 (e.g.
   `https://<service>.ecs.us-east-1.on.aws`), re-run `./infra/put-secrets.sh`, and redeploy so email
   links/callbacks use the right origin:
   ```bash
   aws ecs update-express-gateway-service --region us-east-1 --service-arn <ServiceArn> \
     --primary-container "$(sed 's|REPLACE_WITH_AppSecretArn|<AppSecretArn output>|g' .aws/primary-container.json | jq --arg img "$REG:bootstrap" '.image=$img')" \
     --monitor-resources DEPLOYMENT
   ```
2. Store the service ARN as a repo secret so the pipeline targets it (and the rollout step stops
   self-skipping):
   ```bash
   gh secret set ECS_SERVICE_ARN --repo drschoice/documenso --body "<ServiceArn>"
   ```
3. Commit the infra files and push to `production`. The Action builds `documenso:<sha>`, pushes to ECR,
   and rolls it out (your `.env.prod`/`cert.p12` are git-ignored and never committed):
   ```bash
   git add infra .aws/primary-container.json .github/workflows/deploy-ecs.yml .gitignore .dockerignore
   git commit -m "Add ECS Express Mode deployment"
   git push origin production
   ```

Verify: open the application URL, sign up, create a document, and **sign + seal it** (confirms DB,
encryption keys, SMTP, S3 uploads, and the base64 signing cert). Background sweeps run on the always-on
Fargate CPU — a document that misses its immediate seal is rescued within ~15 min.

---

## Notes / gotchas
- **Migrations on start** — `docker/start.sh` runs `prisma migrate deploy` on boot. Express Mode's
  default health-check grace period is 300s, which covers it. The first boot runs ~157 migrations; you
  can pre-run them once against the DB to de-risk.
- **`NEXT_PUBLIC_WEBAPP_URL` is runtime** — one image serves any URL; changing it just needs a redeploy
  (Phase 5 step 1), never a rebuild.
- **Cron sweeps work** — always-on Fargate CPU (the reason we didn't use App Runner).
- **S3 uploads** — reached via the tasks' public IPs (public subnets); credentials come from the secret.
  To use the task role instead, add `s3:*` on the bucket to `documenso-task` and drop the
  `NEXT_PRIVATE_UPLOAD_*` keys.

## Follow-ups
- **Custom domain** — map your domain to the Express service (Route 53 + the service's ACM cert flow),
  then set `NEXT_PUBLIC_WEBAPP_URL` to it and redeploy.
- **Multi-tenant** — each additional Documenso is another `create-express-gateway-service` (its own
  secret + DB); up to 25 share one ALB automatically.

## How updates work afterwards
- **App code:** push to `production` → pipeline rebuilds and rolls out.
- **Env / secrets list:** edit `.aws/primary-container.json` and push.
- **Secret values:** edit `.env.prod`, re-run `./infra/put-secrets.sh`, then redeploy (push or
  `workflow_dispatch`).
- **Infra (ECR, IAM, log group):** edit `infra/ecs-stack.yml` and re-run the Phase 1 `deploy`.
