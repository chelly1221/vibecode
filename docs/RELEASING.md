# 릴리스와 자동 업데이트

Vibecoder는 GitHub Releases의 `latest.json`을 보고 새 버전을 확인합니다(설정 → 정보 → 업데이트 확인, 시작 시 자동 확인은 설정에서 끌 수 있음).

## 1. 서명 키 (한 번만)

- 개인 키: `C:\Users\<사용자>\.tauri\vibecoder.key` (2026-09-04 생성, 비밀번호 없음). **잃어버리면 기존 설치본이 새 버전을 받을 수 없으니 백업하세요.**
- 공개 키: `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` 에 들어 있습니다.
- GitHub 저장소 Settings → Secrets and variables → Actions 에 다음을 추가합니다.
  - `TAURI_SIGNING_PRIVATE_KEY`: 개인 키 파일의 내용 전체
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 빈 값(비밀번호 없음)

## 2. 릴리스 만들기

1. `src-tauri/tauri.conf.json`, `package.json`, `Cargo.toml`(workspace.package.version)의 버전을 올립니다.
2. 커밋 후 태그를 푸시합니다: `git tag v0.2.0 && git push origin v0.2.0`
3. GitHub Actions(`build-windows`)가 NSIS 설치본, `.sig`, `latest.json`을 만들어 **초안 릴리스**에 올립니다.
4. GitHub에서 초안 릴리스를 확인하고 게시(Publish)하면 설치된 앱들이 업데이트를 감지합니다.

## 3. 로컬 빌드

- 설치본만: `cargo.exe tauri build --bundles nsis` (WSL에서 Windows 툴체인 호출)
- 서명 포함 로컬 빌드: `TAURI_SIGNING_PRIVATE_KEY_PATH=C:\Users\<사용자>\.tauri\vibecoder.key` 환경 변수를 주면 `.sig`도 생성됩니다.
