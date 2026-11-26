#!/usr/bin/env bash
# Create one Amazon Cognito user pool for AI Therapist sign-in (ai-therapist-394).
#
#   scripts/cognito/create-pool.sh <stage|prod> <app-url> <domain-prefix>
#   e.g. scripts/cognito/create-pool.sh stage https://ai-therapist.nathanblatter.com byu-ai-therapist-stage
#
# Run it once per environment, with AWS credentials for the STUDY account that
# are allowed to administer Cognito (the app's own runtime policy,
# iam-app-policy.json, is deliberately too narrow to run this). It refuses to
# run if a pool with the same name already exists; it never modifies or
# deletes an existing pool. Settings and the reasons for them are in
# docs/cognito-auth.md. Keep stage and prod identical by changing this file,
# not the console.
#
# Cost: the Essentials tier is free for the first 10,000 monthly active users
# per account (checked 2026-11-25). Check the pricing page again before running.
set -euo pipefail

ENV_NAME="${1:-}"
APP_URL="${2:-}"
DOMAIN_PREFIX="${3:-}"
REGION="${AWS_REGION:-us-west-1}"
EXPECTED_ACCOUNT="104181502887"

if [[ "$ENV_NAME" != "stage" && "$ENV_NAME" != "prod" ]] || [[ ! "$APP_URL" =~ ^https://[^/]+$ ]] || [[ ! "$DOMAIN_PREFIX" =~ ^[a-z0-9-]+$ ]]; then
  echo "usage: $0 <stage|prod> <https://app-origin, no trailing slash> <domain-prefix>" >&2
  exit 2
fi

export AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]]; then
  echo "refusing: these credentials are for account $ACCOUNT, not the study account $EXPECTED_ACCOUNT" >&2
  exit 1
fi

POOL_NAME="ai-therapist-$ENV_NAME"
EXISTING="$(aws cognito-idp list-user-pools --region "$REGION" --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id" --output text)"
if [[ -n "$EXISTING" ]]; then
  echo "refusing: a pool named $POOL_NAME already exists ($EXISTING)" >&2
  exit 1
fi

echo "==> creating user pool $POOL_NAME in $REGION"
# - Essentials tier: the lowest tier with the hosted managed login.
# - Admin-created accounts only: no self-sign-up. The app links a pool account
#   to its local row by username on the first sign-in, which is only safe when
#   nobody can register a username themselves.
# - Password policy mirrors src/server/utils/passwordPolicy.ts (12 characters,
#   no character-class rules) so the app and the pool accept the same passwords.
# - Usernames are case-sensitive because the app's are.
# - Recovery is admin-only: participants have no email on file.
POOL_ID="$(aws cognito-idp create-user-pool --region "$REGION" \
  --pool-name "$POOL_NAME" \
  --user-pool-tier ESSENTIALS \
  --deletion-protection ACTIVE \
  --admin-create-user-config AllowAdminCreateUserOnly=true \
  --username-configuration CaseSensitive=true \
  --policies 'PasswordPolicy={MinimumLength=12,RequireUppercase=false,RequireLowercase=false,RequireNumbers=false,RequireSymbols=false,TemporaryPasswordValidityDays=7}' \
  --account-recovery-setting 'RecoveryMechanisms=[{Priority=1,Name=admin_only}]' \
  --user-pool-tags "project=ai-therapist,env=$ENV_NAME" \
  --query UserPool.Id --output text)"
echo "    pool id: $POOL_ID"

echo "==> authenticator-app codes available, optional at the pool level"
# The pool can only require a second factor for everyone or for no one. Staff
# are required to have one by the app at sign-in (ai-therapist-396).
aws cognito-idp set-user-pool-mfa-config --region "$REGION" --user-pool-id "$POOL_ID" \
  --software-token-mfa-configuration Enabled=true \
  --mfa-configuration OPTIONAL >/dev/null

echo "==> role groups"
for ROLE in therapist researcher participant demo caseworker; do
  aws cognito-idp create-group --region "$REGION" --user-pool-id "$POOL_ID" \
    --group-name "$ROLE" --description "AI Therapist role: $ROLE" >/dev/null
done

echo "==> hosted sign-in domain $DOMAIN_PREFIX"
aws cognito-idp create-user-pool-domain --region "$REGION" --user-pool-id "$POOL_ID" \
  --domain "$DOMAIN_PREFIX" --managed-login-version 2 >/dev/null

echo "==> app client"
# A server-side client with a secret: only this app's backend exchanges codes.
CLIENT_JSON="$(aws cognito-idp create-user-pool-client --region "$REGION" --user-pool-id "$POOL_ID" \
  --client-name "ai-therapist-$ENV_NAME-web" \
  --generate-secret \
  --supported-identity-providers COGNITO \
  --allowed-o-auth-flows-user-pool-client \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid \
  --callback-urls "$APP_URL/api/auth/cognito/callback" \
  --logout-urls "$APP_URL/login" \
  --prevent-user-existence-errors ENABLED \
  --enable-token-revocation \
  --id-token-validity 60 --access-token-validity 60 --refresh-token-validity 1 \
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days \
  --output json)"
CLIENT_ID="$(printf '%s' "$CLIENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["UserPoolClient"]["ClientId"])')"

echo "==> default look for the hosted page"
aws cognito-idp create-managed-login-branding --region "$REGION" --user-pool-id "$POOL_ID" \
  --client-id "$CLIENT_ID" --use-cognito-provided-values >/dev/null

cat <<OUT

Done. Add these to the $ENV_NAME deployment's .env (never to the repo or CI):

COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_CLIENT_ID=$CLIENT_ID
COGNITO_DOMAIN=https://$DOMAIN_PREFIX.auth.$REGION.amazoncognito.com
COGNITO_CLIENT_SECRET=<read it with the command below; it is not printed here>

  aws cognito-idp describe-user-pool-client --region $REGION --user-pool-id $POOL_ID \\
    --client-id $CLIENT_ID --query UserPoolClient.ClientSecret --output text

Pool ARN, for iam-app-policy.json:
  arn:aws:cognito-idp:$REGION:$ACCOUNT:userpool/$POOL_ID
OUT
