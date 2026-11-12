#!/usr/bin/env python3
"""Exercise the actual workflow's Git operations against local repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

CONTROLLER = Path(__file__).resolve().parent
WORKFLOW = CONTROLLER.parent / 'workflows/fork-publish.yml'


def step(name):
    section = WORKFLOW.read_text().split(f'      - name: {name}\n', 1)[1]
    section = section.split('\n      - ', 1)[0]
    block = section.split('        run: |\n', 1)[1]
    return textwrap.dedent(block)


class PublishingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.remote = self.root / 'origin.git'
        self.repo.mkdir()
        self.env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1',
                    'GIT_CONFIG_GLOBAL': '/dev/null', 'GITHUB_REPOSITORY': 'test/plugins',
                    'GITHUB_STEP_SUMMARY': str(self.root / 'summary'),
                    'GITHUB_ENV': str(self.root / 'env'), 'TEST_PRS': ''}
        self.git('init', '-q', '--bare', self.remote)
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'core.hooksPath', '/dev/null')
        self.git('remote', 'add', 'origin', self.remote)
        self.list = self.repo / '.github/fork/active-branches'
        self.list.parent.mkdir(parents=True)
        self.list.write_text('fix/example\n')
        (self.repo / 'source').write_text('base\n')
        self.commit('base')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('update-ref', 'refs/remotes/upstream/master', self.base)
        self.git('push', '-q', 'origin', 'master')
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text('#!/bin/bash\nprintf "%s\\n" "$TEST_PRS"\n')
        gh.chmod(0o755)
        self.env['PATH'] = f'{bin_dir}:{self.env["PATH"]}'

    def git(self, *args, check=True):
        result = subprocess.run(['git', '-C', str(self.repo), *map(str, args)],
                                env=self.env, text=True, capture_output=True, check=check)
        return result.stdout.strip()

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-qm', message)

    def feature(self):
        self.git('switch', '-qc', 'fix/example')
        (self.repo / 'feature').write_text('feature\n')
        self.commit('feature')
        head = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'fix/example')
        self.git('switch', '-q', 'master')
        return head

    def run_step(self, name, success=True):
        result = subprocess.run(['bash', '-euo', 'pipefail', '-c', step(name)],
                                cwd=self.repo, env=self.env, text=True, capture_output=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def pr(self, head, merge, merged='2026-11-12', state='closed'):
        self.env['TEST_PRS'] = f'42\t{state}\t{merged}\t{head}\t{merge}'

    def test_missing_active_branch_stops_without_pushing_source(self):
        result = self.run_step('Retire branches merged upstream', success=False)
        self.assertIn('active but unavailable', result.stdout)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/master').split()[0], self.base)
        self.assertEqual(self.list.read_text(), 'fix/example\n')

    def test_old_merged_pr_does_not_retire_new_branch_head(self):
        self.feature()
        self.pr(self.base, self.base)
        self.run_step('Retire branches merged upstream')
        self.assertEqual(self.list.read_text(), 'fix/example\n')

    def test_merge_not_in_upstream_does_not_retire(self):
        head = self.feature()
        self.pr(head, head)
        self.run_step('Retire branches merged upstream')
        self.assertEqual(self.list.read_text(), 'fix/example\n')

    def test_exact_head_merged_into_fetched_upstream_retires(self):
        head = self.feature()
        self.git('update-ref', 'refs/remotes/upstream/master', head)
        self.pr(head, head)
        self.run_step('Retire branches merged upstream')
        self.assertEqual(self.list.read_text(), '')
        self.assertNotEqual(self.git('ls-remote', 'origin', 'refs/heads/master').split()[0], self.base)

    def test_closed_unmerged_branch_stays_and_warns(self):
        head = self.feature()
        self.pr(head, '-', merged='-')
        result = self.run_step('Retire branches merged upstream')
        self.assertIn('::warning::', result.stdout)
        self.assertEqual(self.list.read_text(), 'fix/example\n')

    def test_build_uses_pinned_head_even_if_branch_moves(self):
        head = self.feature()
        self.run_step('Retire branches merged upstream')
        self.git('switch', '-q', 'fix/example')
        (self.repo / 'later').write_text('not part of this build\n')
        self.commit('later')
        self.git('push', '-q', 'origin', 'fix/example')
        self.git('switch', '-q', 'master')
        self.run_step('Merge active branches for this build only')
        self.assertEqual(self.git('rev-parse', 'HEAD^2'), head)
        self.assertFalse((self.repo / 'later').exists())

    def test_build_conflict_stops_without_replacing_remote_source(self):
        self.git('switch', '-qc', 'fix/example')
        (self.repo / 'source').write_text('feature edit\n')
        self.commit('feature')
        self.git('push', '-q', 'origin', 'fix/example')
        self.git('switch', '-q', 'master')
        (self.repo / 'source').write_text('upstream edit\n')
        self.commit('upstream')
        self.run_step('Retire branches merged upstream')
        remote_head = self.git('ls-remote', 'origin', 'refs/heads/master')
        self.run_step('Merge active branches for this build only', success=False)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/master'), remote_head)

    def generated_output(self):
        self.env['PUBLISH_BRANCH'] = 'plugins/v3.0.0'
        for name in ('public/static', '.dist', '.js/src/plugins'):
            directory = self.repo / name
            directory.mkdir(parents=True)
            (directory / 'generated').write_text('generated\n')
        (self.repo / 'total.svg').write_text('<svg/>\n')

    def build_tools(self):
        (self.repo / 'package.json').write_text('{"version":"3.0.0"}')
        (self.repo / '.js/plugins').mkdir(parents=True)
        npm = self.root / 'bin/npm'
        npm.write_text('#!/bin/bash\nexit 0\n')
        npm.chmod(0o755)

    def test_build_captures_expected_generated_revision(self):
        self.build_tools()
        self.git('push', '-q', 'origin', f'{self.base}:refs/heads/plugins/v3.0.0')
        self.run_step('Build plugins with fork URLs')
        self.assertIn(f'PUBLISH_PREVIOUS_SHA={self.base}\n', (self.root / 'env').read_text())

    def test_remote_read_failure_is_not_treated_as_new_generated_branch(self):
        self.build_tools()
        self.git('remote', 'set-url', 'origin', self.root / 'missing.git')
        self.run_step('Build plugins with fork URLs', success=False)
        self.assertNotIn('PUBLISH_PREVIOUS_SHA=', (self.root / 'env').read_text())

    def test_generated_ref_creation_uses_empty_lease(self):
        self.generated_output()
        self.env['PUBLISH_PREVIOUS_SHA'] = ''
        self.run_step('Publish app repository')
        self.assertTrue(self.git('ls-remote', 'origin', 'refs/heads/plugins/v3.0.0'))

    def test_generated_ref_update_accepts_matching_lease(self):
        self.generated_output()
        self.git('push', '-q', 'origin', f'{self.base}:refs/heads/plugins/v3.0.0')
        self.env['PUBLISH_PREVIOUS_SHA'] = self.base
        self.run_step('Publish app repository')
        self.assertNotEqual(self.git('ls-remote', 'origin', 'refs/heads/plugins/v3.0.0').split()[0], self.base)

    def test_generated_ref_concurrent_update_is_preserved(self):
        self.generated_output()
        self.git('push', '-q', 'origin', f'{self.base}:refs/heads/plugins/v3.0.0')
        self.env['PUBLISH_PREVIOUS_SHA'] = self.base
        (self.repo / 'source').write_text('concurrent writer\n')
        self.commit('concurrent')
        newer = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', f'{newer}:refs/heads/plugins/v3.0.0')
        self.run_step('Publish app repository', success=False)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/plugins/v3.0.0').split()[0], newer)

    def test_new_request_rejects_dirty_checkout_before_fetch_or_switch(self):
        (self.repo / 'source').write_text('unfinished\n')
        result = subprocess.run(['bash', str(CONTROLLER / 'branch.sh'), 'new', 'fix/new'],
                                cwd=self.repo, env=self.env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('commit or stash', result.stderr)
        self.assertEqual(self.git('branch', '--show-current'), 'master')
        self.assertEqual((self.repo / 'source').read_text(), 'unfinished\n')


if __name__ == '__main__':
    unittest.main()
