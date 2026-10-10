#!/usr/bin/env node
/**
 * source-api-push.js - 推送 API 到线上
 *
 * 用法: node source-api-push.js [api-id]
 *
 * 参数:
 *   api-id     - API ID 或目录 ID
 *                如果是目录 ID，则推送该目录及目录下的所有 API
 *                如果是 API ID，则只推送该 API
 *
 * 示例:
 *   node source-api-push.js 123456
 *   node source-api-push.js abc123
 *
 * 环境变量:
 *   SERVER_URL   - 服务器地址 (默认: http://localhost:8080)
 *   USERNAME     - 用户名
 *   PASSWORD     - 密码
 *   PROJECT_UUID - 项目 UUID
 */

// 设置控制台编码为 UTF-8
try {
    require('child_process').execSync('chcp 65001 > nul', { stdio: 'ignore', shell: true });
} catch (e) {}

// 设置 process.stdout 和 process.stderr 的编码
if (process.stdout && process.stdout.setEncoding) {
    process.stdout.setEncoding('utf8');
}
if (process.stderr && process.stderr.setEncoding) {
    process.stderr.setEncoding('utf8');
}

// 解决 Windows 下的中文编码问题
try {
    // 设置控制台输出编码
    process.env.JS_UTC_MS = 'true';
    // 确保正确的中文显示
    if (typeof process !== 'undefined' && process.binding && process.binding('natives')) {
        // Node.js 原生设置
    }
} catch (e) {}

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');
const utils = require('./utils');

// 加载 .env 环境变量
utils.loadEnv();

// 创建 ZIP 包
function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            resolve(outputPath);
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const PROJECT_UUID = process.env.PROJECT_UUID || '';
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';

const apiId = process.argv[2];

// 判断是否是推送所有 API
const pushAll = apiId === '-a';

if (!pushAll && !apiId) {
    console.error('❌ 错误: 请提供 API ID 或使用 -a 推送所有 API');
    console.error('');
    console.error('用法:');
    console.error('  node source-api-push.js <api-id>   # 推送单个 API 或目录');
    console.error('  node source-api-push.js -a          # 推送所有 API');
    console.error('');
    console.error('示例:');
    console.error('  node source-api-push.js abc123');
    console.error('  node source-api-push.js -a');
    process.exit(1);
}

// 确定项目目录
let projectDir;
if (PROJECT_UUID) {
    projectDir = path.join(__dirname, PROJECT_UUID);
} else {
    // 尝试从 manifest.json 获取
    const dirs = fs.readdirSync(__dirname);
    for (const dir of dirs) {
        const manifestPath = path.join(__dirname, dir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (manifest.projectUuid) {
                    projectDir = path.join(__dirname, dir);
                    break;
                }
            } catch (e) {
                // 跳过
            }
        }
    }
}

if (!projectDir || !fs.existsSync(projectDir)) {
    console.error('❌ 错误: 项目目录不存在');
    console.error('请确保在 .env 中配置了 PROJECT_UUID，或先运行 source-pull.js');
    process.exit(1);
}

const apisDir = path.join(projectDir, 'apis');
const cookiesFile = path.join(projectDir, '.cookies');

async function main() {
    console.log('========================================');
    console.log('  推送 API 到线上');
    console.log('========================================');
    console.log(`服务器地址: ${SERVER_URL}`);
    console.log(`项目目录:  ${projectDir}`);
    console.log(`API ID:    ${pushAll ? '(所有 API)' : apiId}`);
    console.log('========================================');
    console.log('');

    let tempDir = null;

    try {
        // 检查 apis 目录
        if (!fs.existsSync(apisDir)) {
            console.error('❌ 错误: apis 目录不存在');
            process.exit(1);
        }

        // 步骤 1: 登录
        console.log('[1/5] 登录...');
        // 密码不拼进命令行：那样会出现在进程列表里，而且密码含 " 或 $ 时还会把命令拼坏。
        // 改成 --data-binary @- 从 stdin 喂 JSON body。
        const loginUrl = `${SERVER_URL}/youyaboot-admin/magical_lowcode/server/web/login`;
        const loginCmd = `curl -s -c "${cookiesFile}" -X POST "${loginUrl}" -H "Content-Type: application/json" --data-binary @-`;
        const loginResponse = execSync(loginCmd, {
            encoding: 'utf-8',
            input: JSON.stringify({ userName: USERNAME, password: PASSWORD })
        });

        if (!loginResponse.includes('"code":0')) {
            console.error(`✗ 登录失败: ${loginResponse}`);
            process.exit(1);
        }
        console.log('✓ 登录成功');

        // 步骤 2: 确定要推送的目标
        console.log('');
        console.log('[2/5] 确定推送目标...');

        let targetPath;
        let targetId;
        let isDirectory = false;

        if (pushAll) {
            targetPath = apisDir;
            targetId = '';
            console.log('✓ 推送模式: 所有 API');
            console.log(`✓ 目标路径: ${targetPath}`);
        } else {
            // 扫描 apis 目录找到目标
            const existingDirs = utils.scanMetaFiles(apisDir);

            // 确定是目录还是 API
            // 先检查是否是目录 ID
            const dirMeta = existingDirs.find(d => d.id == apiId || d.meta.id == apiId);
            if (dirMeta) {
                targetPath = dirMeta.dirPath;
                targetId = apiId;
                isDirectory = true;
                console.log(`✓ 找到目录: ${dirMeta.path || dirMeta.name}`);
            } else {
                // 检查是否是 API ID
                for (const dir of existingDirs) {
                    const apiSubDirs = fs.readdirSync(dir.dirPath).filter(item => {
                        const itemPath = path.join(dir.dirPath, item);
                        return fs.statSync(itemPath).isDirectory();
                    });

                    for (const apiSubDir of apiSubDirs) {
                        const apiMetaPath = path.join(dir.dirPath, apiSubDir, 'meta.json');
                        if (fs.existsSync(apiMetaPath)) {
                            try {
                                const apiMeta = JSON.parse(fs.readFileSync(apiMetaPath, 'utf-8'));
                                if (apiMeta.id == apiId || apiMeta.id === apiId) {
                                    targetPath = path.join(dir.dirPath, apiSubDir);
                                    targetId = apiId;
                                    console.log(`✓ 找到 API: ${dir.path || dir.name}/${apiSubDir}`);
                                    break;
                                }
                            } catch (e) {
                                // 跳过
                            }
                        }
                    }
                    if (targetPath) break;
                }
            }

            if (!targetPath) {
                console.error(`✗ 错误: 找不到 API 或目录 (id: ${apiId})`);
                process.exit(1);
            }
            console.log(`✓ 目标路径: ${targetPath}`);
        }

        // 步骤 3: 准备 API（将 script.js 合并到 meta.json）
        console.log('');
        console.log('[3/5] 准备 API...');

        tempDir = path.join(projectDir, `.temp_api_push_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // 创建临时 apis 目录
        const tempApisDir = path.join(tempDir, 'apis');
        fs.mkdirSync(tempApisDir, { recursive: true });

        // 复制并准备 API
        function copyAndPrepareApi(srcApiDir, destApiDir, relativePath) {
            if (!fs.existsSync(srcApiDir)) return;

            fs.mkdirSync(destApiDir, { recursive: true });

            const metaJsonPath = path.join(srcApiDir, 'meta.json');
            const scriptFile = path.join(srcApiDir, 'script.js');

            console.log(`  准备 API: ${relativePath}`);

            // 读取并合并到 metaData
            const metaData = JSON.parse(fs.readFileSync(metaJsonPath, 'utf-8'));

            if (fs.existsSync(scriptFile)) {
                metaData.script = fs.readFileSync(scriptFile, 'utf-8');
                // 同时复制 script.js 文件
                fs.copyFileSync(scriptFile, path.join(destApiDir, 'script.js'));
            }

            // 写入合并后的 meta.json
            fs.writeFileSync(path.join(destApiDir, 'meta.json'), JSON.stringify(metaData, null, 2), 'utf-8');
        }

        // 递归复制目录下的所有 API
        function copyAllApis(srcDir, destDir, relativePath = '') {
            if (!fs.existsSync(srcDir)) return;

            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                const srcItemPath = path.join(srcDir, item);
                const destItemPath = path.join(destDir, item);
                const stat = fs.statSync(srcItemPath);

                if (stat.isDirectory()) {
                    const metaJsonPath = path.join(srcItemPath, 'meta.json');
                    const currentRelativePath = relativePath ? `${relativePath}/${item}` : item;

                    if (fs.existsSync(metaJsonPath)) {
                        // 这是一个 API 目录，复制并准备
                        copyAndPrepareApi(srcItemPath, destItemPath, currentRelativePath);
                    }

                    // 递归处理子目录
                    copyAllApis(srcItemPath, destItemPath, currentRelativePath);
                }
            }
        }

        // 检查目标路径是否直接是一个 API 目录（有 meta.json）
        const targetMetaJsonPath = path.join(targetPath, 'meta.json');
        if (fs.existsSync(targetMetaJsonPath)) {
            // targetPath 直接是一个 API 目录
            console.log(`  调试: targetPath 是 API 目录，直接复制`);

            // 复制到 tempApisDir 下的 API 名称子目录
            const apiName = path.basename(targetPath);
            const destApiDir = path.join(tempApisDir, apiName);
            copyAndPrepareApi(targetPath, destApiDir, apiName);

            // 递归复制所有子目录和文件
            copyAllApis(targetPath, destApiDir, apiName);
        } else {
            // targetPath 是 apis 目录或普通目录，需要遍历
            copyAllApis(targetPath, tempApisDir);
        }
        console.log('✓ API 准备完成');

        // 调试：检查临时目录内容
        console.log('  调试: 临时目录内容:');
        function printDir(dir, prefix = '') {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                    console.log(`  ${prefix}${item}/`);
                    printDir(itemPath, prefix + '  ');
                } else {
                    const size = stat.size;
                    console.log(`  ${prefix}${item} (${size} bytes)`);
                }
            }
        }
        printDir(tempApisDir);

        // 步骤 4: 生成 api-directory.json
        console.log('');
        console.log('[4/5] 生成 api-directory.json...');

        const allDirMetas = [];
        const allApiList = [];

        function collectApiInfo(srcDir, relativePath = '') {
            if (!fs.existsSync(srcDir)) return;

            const items = fs.readdirSync(srcDir);
            for (const item of items) {
                const itemPath = path.join(srcDir, item);
                const stat = fs.statSync(itemPath);

                if (stat.isDirectory()) {
                    const metaJsonPath = path.join(itemPath, 'meta.json');

                    if (fs.existsSync(metaJsonPath)) {
                        try {
                            const metaData = JSON.parse(fs.readFileSync(metaJsonPath, 'utf-8'));

                            if (relativePath) {
                                // 子目录下的 meta.json 是 API 目录
                                allApiList.push(metaData);
                            } else {
                                // 顶级目录的 meta.json 是目录
                                allDirMetas.push(metaData);
                            }
                        } catch (e) {
                            // 跳过
                        }
                    }

                    const currentRelativePath = relativePath ? `${relativePath}/${item}` : item;
                    collectApiInfo(itemPath, currentRelativePath);
                }
            }
        }

        collectApiInfo(tempApisDir);

        const apiDirectory = {
            directories: allDirMetas,
            apiInfos: allApiList,
            deleteOld: false,
            projectId: null
        };

        fs.writeFileSync(
            path.join(tempApisDir, 'api-directory.json'),
            JSON.stringify(apiDirectory, null, 2),
            'utf-8'
        );

        console.log(`✓ 已生成 api-directory.json: ${allDirMetas.length} 个目录, ${allApiList.length} 个 API`);

        // 步骤 5: 打包为 ZIP
        console.log('');
        console.log('[5/5] 打包 API...');

        const tempZipPath = path.join(projectDir, `.temp-push-api-${Date.now()}.zip`);
        await createZip(tempApisDir, tempZipPath);

        const fileSize = fs.statSync(tempZipPath).size;
        const fileSizeStr = fileSize > 1024 * 1024
            ? `${(fileSize / 1024 / 1024).toFixed(2)} MB`
            : `${(fileSize / 1024).toFixed(2)} KB`;
        console.log(`✓ 已打包: ${fileSizeStr}`);

        // 步骤 5: 上传到服务器
        console.log('');
        console.log('[5/5] 上传到服务器...');

        const importUrl = `${SERVER_URL}/youyaboot-admin/magicalcoder/user/project/api-import?projectUuid=${PROJECT_UUID}&apiId=${targetId || ''}`;

        // 使用 curl 上传文件
        const uploadCmd = `curl -s -b "${cookiesFile}" -X POST "${importUrl}" -F "file=@${tempZipPath}"`;
        const uploadResponse = execSync(uploadCmd, { encoding: 'utf-8' });

        // 清理临时文件
        fs.unlinkSync(tempZipPath);
        fs.rmdirSync(tempDir, { recursive: true });

        try {
            const result = JSON.parse(uploadResponse);
            if (result.code === 0) {
                console.log('✓ 上传成功');
            } else {
                console.error(`✗ 上传失败: ${result.msg || uploadResponse}`);
                process.exit(1);
            }
        } catch (e) {
            console.error(`✗ 上传失败: ${uploadResponse}`);
            process.exit(1);
        }

        // 清理 cookies
        if (fs.existsSync(cookiesFile)) {
            fs.unlinkSync(cookiesFile);
        }

        console.log('');
        console.log('========================================');
        console.log('✅ 推送成功!');
        console.log('========================================');
        console.log('');
        console.log('提示: 线上 API 已更新');
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 推送失败:', error.message);

        // 清理临时目录
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmdirSync(tempDir, { recursive: true });
        }

        if (fs.existsSync(cookiesFile)) {
            fs.unlinkSync(cookiesFile);
        }
        process.exit(1);
    }
}

main();
