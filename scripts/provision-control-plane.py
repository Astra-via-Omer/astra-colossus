#!/usr/bin/env python3
"""Provision only Colossus's database and vault; never print or save key material."""
import argparse, json, secrets, subprocess
parser=argparse.ArgumentParser()
parser.add_argument('--project', default='astra-via')
parser.add_argument('--region', default='me-west1')
parser.add_argument('--database', default='astra-colossus')
parser.add_argument('--workspace-database', default='astra-workspace')
parser.add_argument('--runtime', default='astra-colossus-runtime@astra-via.iam.gserviceaccount.com')
parser.add_argument('--account')
args=parser.parse_args()
common=['--project='+args.project,'--quiet']+(['--account='+args.account] if args.account else [])
def run(arguments, **kwargs):
 result=subprocess.run(['gcloud',*arguments,*common],capture_output=True,text=True,**kwargs)
 if result.returncode: raise RuntimeError(result.stderr)
 return result.stdout
existing=json.loads(run(['firestore','databases','list','--format=json']))
if not any(database['name'].endswith('/databases/'+args.database) for database in existing):
 run(['firestore','databases','create','--database='+args.database,'--location='+args.region,'--type=firestore-native','--delete-protection'])
print('Dedicated Firestore database is ready',flush=True)
condition='expression=resource.name=="projects/'+args.project+'/databases/'+args.database+'",title=colossus-control-database'
run(['projects','add-iam-policy-binding',args.project,'--member=serviceAccount:'+args.runtime,'--role=roles/datastore.user','--condition='+condition,'--format=none'])
print('Runtime write access is scoped to Colossus',flush=True)
workspace_condition='expression=resource.name=="projects/'+args.project+'/databases/'+args.workspace_database+'",title=colossus-workspace-membership-read'
run(['projects','add-iam-policy-binding',args.project,'--member=serviceAccount:'+args.runtime,'--role=roles/datastore.viewer','--condition='+workspace_condition,'--format=none'])
print('Read-only live Workspace membership access is scoped to its database',flush=True)
secret='astra-colossus-vault'
existing_secrets=json.loads(run(['secrets','list','--format=json']))
if not any(value['name'].endswith('/secrets/'+secret) for value in existing_secrets):
 run(['secrets','create',secret,'--replication-policy=automatic','--format=none'])
versions=json.loads(run(['secrets','versions','list',secret,'--format=json']))
if not versions: run(['secrets','versions','add',secret,'--data-file=-','--format=none'],input=secrets.token_urlsafe(48))
run(['secrets','add-iam-policy-binding',secret,'--member=serviceAccount:'+args.runtime,'--role=roles/secretmanager.secretAccessor','--format=none'])
print('Dedicated vault secret is ready; no key material was printed',flush=True)
