#!/usr/bin/env bash
# One-time (and rotation) setup of the AWS side of outside-adapter runs. Run it with an AWS admin profile on a machine that has the aws CLI, jq and doppler:
#   tools/outsider/provision-aws.sh              # create/refresh everything, rotate the key
#   tools/outsider/provision-aws.sh --dry-run    # print what it would do, change nothing
# What it makes (all names start open-haul-outsider-; it never touches anything that already exists under another name):
#   1. an IAM user that can ONLY call bedrock:InvokeModel and InvokeModelWithResponseStream on the bench model (policy-invoke.json, plus an explicit deny on everything else)
#   2. a Bedrock API key for that user that expires in 30 days, written straight into Doppler (OUTSIDER_BEDROCK_API_KEY): the key is never printed
#   3. a monthly cost budget with mail alerts at 50/80/100%, and at 100% an automatic action that attaches a deny-all policy to that user
# Budgets lag real spend by hours, so the budget is a backstop. The per-run cap is --cap-usd, enforced by the bench's own meter inside the run.
set -euo pipefail
cd "$(dirname "$0")"

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
USER_NAME=${OUTSIDER_IAM_USER:-open-haul-outsider-bedrock}
DENY_POLICY=open-haul-outsider-deny-all
ACTION_ROLE=open-haul-outsider-budget-action
BUDGET=open-haul-outsider-bedrock-monthly
LIMIT_USD=${OUTSIDER_MONTHLY_USD:-25}
KEY_DAYS=${OUTSIDER_KEY_DAYS:-30}
REGION=${AWS_REGION:-us-east-1}
EMAIL=${OUTSIDER_ALERT_EMAIL:?set OUTSIDER_ALERT_EMAIL to the address that should get budget alerts}
DOPPLER_PROJECT=${OUTSIDER_DOPPLER_PROJECT:-argentic}
DOPPLER_CONFIG=${OUTSIDER_DOPPLER_CONFIG:-dev}

run() { if [ "$DRY" = 1 ]; then printf 'DRY:'; printf ' %q' "$@"; echo; else "$@"; fi; }
need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 2; }; }
need aws; need jq; [ "$DRY" = 1 ] || need doppler

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "account $ACCOUNT, region $REGION, user $USER_NAME"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fill() { sed -e "s/__ACCOUNT__/$ACCOUNT/g" -e "s/__REGION__/$REGION/g" -e "s/__USER__/$USER_NAME/g" -e "s/__DENY_POLICY__/$DENY_POLICY/g" "$1" > "$2"; jq -e . "$2" >/dev/null; }
fill policy-invoke.json "$T/invoke.json"; fill policy-deny-all.json "$T/deny.json"
fill budget-action-role-trust.json "$T/trust.json"; fill budget-action-role-policy.json "$T/role-policy.json"

# 1. the user and its one policy
aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || run aws iam create-user --user-name "$USER_NAME" --tags Key=purpose,Value=open-haul-outsider-adapter-runs
run aws iam put-user-policy --user-name "$USER_NAME" --policy-name bedrock-invoke-bench-model-only --policy-document "file://$T/invoke.json"
# nothing else may be attached: list, and refuse to continue if the user picked up a managed policy other than our deny
extra=$(aws iam list-attached-user-policies --user-name "$USER_NAME" --query "AttachedPolicies[?PolicyName!='$DENY_POLICY'].PolicyName" --output text 2>/dev/null || true)
[ -z "$extra" ] || { echo "REFUSING: $USER_NAME has extra managed policies attached: $extra" >&2; exit 3; }

# 2. the key: drop old Bedrock keys of this user, make a new expiring one, pipe it into Doppler without printing it
for id in $(aws iam list-service-specific-credentials --user-name "$USER_NAME" --service-name bedrock.amazonaws.com --query 'ServiceSpecificCredentials[].ServiceSpecificCredentialId' --output text 2>/dev/null || true); do
  run aws iam delete-service-specific-credential --user-name "$USER_NAME" --service-specific-credential-id "$id"
done
if [ "$DRY" = 1 ]; then echo "DRY: create-service-specific-credential for $USER_NAME ($KEY_DAYS days) | doppler secrets set OUTSIDER_BEDROCK_API_KEY"; else
  exp=$(date -u -d "+$KEY_DAYS days" +%F)
  aws iam create-service-specific-credential --user-name "$USER_NAME" --service-name bedrock.amazonaws.com --credential-age-days "$KEY_DAYS" \
    | jq -r '.ServiceSpecificCredential.ServiceCredentialSecret' \
    | doppler secrets set OUTSIDER_BEDROCK_API_KEY --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --silent
  doppler secrets set OUTSIDER_BEDROCK_MODEL=global.anthropic.claude-haiku-5-5 OUTSIDER_BEDROCK_REGION="$REGION" OUTSIDER_BEDROCK_KEY_EXPIRES="$exp" --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --silent
  echo "key stored in Doppler $DOPPLER_PROJECT/$DOPPLER_CONFIG as OUTSIDER_BEDROCK_API_KEY (expires $exp)"
fi

# 3. the budget and its automatic cutoff
aws iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT:policy/$DENY_POLICY" >/dev/null 2>&1 || run aws iam create-policy --policy-name "$DENY_POLICY" --policy-document "file://$T/deny.json"
aws iam get-role --role-name "$ACTION_ROLE" >/dev/null 2>&1 || run aws iam create-role --role-name "$ACTION_ROLE" --assume-role-policy-document "file://$T/trust.json"
run aws iam put-role-policy --role-name "$ACTION_ROLE" --policy-name attach-deny-to-outsider-only --policy-document "file://$T/role-policy.json"

# only count Bedrock lines (Claude on Bedrock bills under "<model> (Amazon Bedrock Edition)"); fall back to the whole account if Cost Explorer shows none yet
svc=$(aws ce get-dimension-values --dimension SERVICE --search-string Bedrock --time-period "Start=$(date -u -d '-60 days' +%F),End=$(date -u +%F)" --query 'DimensionValues[].Value' --output json 2>/dev/null || echo '[]')
if [ "$(echo "$svc" | jq length)" -gt 0 ]; then filter=$(jq -n --argjson s "$svc" '{Service:$s}'); else filter='{}'; echo "no Bedrock service names in Cost Explorer yet: budget will watch the whole account"; fi
jq -n --arg n "$BUDGET" --arg l "$LIMIT_USD" --argjson f "$filter" '{BudgetName:$n,BudgetType:"COST",TimeUnit:"MONTHLY",BudgetLimit:{Amount:$l,Unit:"USD"},CostFilters:$f}' > "$T/budget.json"
jq -n --arg e "$EMAIL" '[50,80,100] | map({Notification:{NotificationType:"ACTUAL",ComparisonOperator:"GREATER_THAN",Threshold:.,ThresholdType:"PERCENTAGE"},Subscribers:[{SubscriptionType:"EMAIL",Address:$e}]})' > "$T/notifications.json"
aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "$BUDGET" >/dev/null 2>&1 && run aws budgets delete-budget --account-id "$ACCOUNT" --budget-name "$BUDGET"
run aws budgets create-budget --account-id "$ACCOUNT" --budget "file://$T/budget.json" --notifications-with-subscribers "file://$T/notifications.json"
jq -n --arg arn "arn:aws:iam::$ACCOUNT:policy/$DENY_POLICY" --arg role "arn:aws:iam::$ACCOUNT:role/$ACTION_ROLE" --arg u "$USER_NAME" --arg e "$EMAIL" '{
  NotificationType:"ACTUAL",ActionType:"APPLY_IAM_POLICY",ActionThreshold:{ActionThresholdValue:100,ActionThresholdType:"PERCENTAGE"},
  Definition:{IamActionDefinition:{PolicyArn:$arn,Users:[$u]}},ExecutionRoleArn:$role,ApprovalModel:"AUTOMATIC",Subscribers:[{SubscriptionType:"EMAIL",Address:$e}]}' > "$T/action.json"
run aws budgets create-budget-action --account-id "$ACCOUNT" --budget-name "$BUDGET" \
  --notification-type ACTUAL --action-type APPLY_IAM_POLICY --action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE \
  --definition "$(jq -c .Definition "$T/action.json")" --execution-role-arn "arn:aws:iam::$ACCOUNT:role/$ACTION_ROLE" --approval-model AUTOMATIC \
  --subscribers "SubscriptionType=EMAIL,Address=$EMAIL"
echo "done. Check it:  tools/outsider/provision-aws.sh --dry-run   and   aws iam list-user-policies --user-name $USER_NAME"
