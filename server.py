"""启动余白本机 Python 服务；不安装依赖，不连接外部服务。"""

from backend.server import main, make_server


if __name__ == "__main__":
    raise SystemExit(main())
