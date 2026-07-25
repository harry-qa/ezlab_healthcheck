"""
gh-pages에 무한 누적되는 실행별 리포트 폴더(YYYY-MM-DD_HH-MM)를
보존 기간(RETENTION_DAYS)이 지나면 삭제해 GitHub Pages 1GB 한도를 방어한다.

- 삭제 대상: 최상위 런 폴더 중 날짜가 cutoff 이전인 것만
- 절대 건드리지 않음: statuses.json / perf-history.json / monthly-stats.json /
  daily-stats.json / failures-history.json / index.html 등 집계·페이지 파일
- 집계 도넛/히트맵은 별도 누적 파일이라 폴더 삭제와 무관하게 보존됨
  (단, backfill_stats.py를 폴더 삭제 후 재실행하면 안 됨)

git 워킹트리 체크아웃 없이 plumbing(read-tree→rm--cached→write-tree→commit-tree→push)으로 처리.
DRY_RUN=1 이면 대상만 출력하고 push 안 함.
"""
import subprocess, re, sys, os
from datetime import date, datetime, timedelta

RETENTION_DAYS = int(os.environ.get('RETENTION_DAYS', '120'))
RUN_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$')
DRY_RUN = os.environ.get('DRY_RUN') == '1' or '--dry-run' in sys.argv


def git(*args, env=None, check=False):
    return subprocess.run(['git', *args], capture_output=True, text=True, env=env, check=check)


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


git('fetch', 'origin', 'gh-pages')
if git('rev-parse', '--verify', 'origin/gh-pages').returncode != 0:
    print('gh-pages 브랜치 없음 — 스킵')
    sys.exit(0)

entries = git('ls-tree', '--name-only', 'origin/gh-pages').stdout.splitlines()
folders = [e for e in entries if RUN_RE.match(e)]

cutoff = date.today() - timedelta(days=RETENTION_DAYS)
def fdate(f):
    return datetime.strptime(f[:10], '%Y-%m-%d').date()

old = sorted(f for f in folders if fdate(f) < cutoff)
print(f'런 폴더 {len(folders)}개 / cutoff {cutoff}({RETENTION_DAYS}일) 이전 {len(old)}개')

if not old:
    print('삭제 대상 없음 — 종료')
    sys.exit(0)

print(f'삭제 대상: {old[0]} ~ {old[-1]}')
if DRY_RUN:
    print('[DRY_RUN] push 생략')
    sys.exit(0)

# 임시 인덱스에 gh-pages 트리를 올리고 대상 폴더만 제거 → 새 트리 작성
idx = '/tmp/prune.index'
if os.path.exists(idx):
    os.remove(idx)
env = dict(os.environ, GIT_INDEX_FILE=idx)
git('read-tree', 'origin/gh-pages', env=env, check=True)
for batch in chunks(old, 200):
    git('rm', '-r', '--cached', '--quiet', '--ignore-unmatch', *batch, env=env, check=True)
tree = git('write-tree', env=env, check=True).stdout.strip()

msg = f'정리: {RETENTION_DAYS}일 경과 런 폴더 {len(old)}개 삭제 ({old[0]} ~ {old[-1]})'
commit = git('commit-tree', tree, '-p', 'origin/gh-pages', '-m', msg, check=True).stdout.strip()
push = git('push', 'origin', f'{commit}:refs/heads/gh-pages')
sys.stdout.write(push.stdout)
sys.stderr.write(push.stderr)
if push.returncode != 0:
    # 워크플로 스텝이 continue-on-error라 exit(1)은 조용히 삼켜진다 → 실패가 여러 런 이어지면
    # gh-pages가 1GB 한도로 계속 커지는데 아무도 모른다. Actions 요약에 뜨는 경고로 가시화한다.
    print('::warning title=헬스체크 리포트 정리 실패::prune push 실패 — 오래된 gh-pages 런 폴더가 정리되지 않았습니다(용량 누적 주의). 실행 로그를 확인하세요.')
    print('push 실패')
    sys.exit(1)
print(f'삭제 완료: {len(old)}개')
