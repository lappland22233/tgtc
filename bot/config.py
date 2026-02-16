"""
配置管理模块
"""
import os
import json
from typing import Dict, Any
import logging

logger = logging.getLogger(__name__)


class Config:
    """配置管理类"""

    def __init__(self, config_path: str = 'data.json'):
        """
        加载配置文件

        Args:
            config_path: 配置文件路径
        """
        self.config_path = config_path
        self.config: Dict[str, Any] = {}
        self.load_config()

    def load_config(self) -> bool:
        """
        加载配置文件

        Returns:
            bool: 加载是否成功
        """
        try:
            if not os.path.exists(self.config_path):
                logger.error(f"配置文件不存在: {self.config_path}")
                return False

            with open(self.config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)

            # 验证必要配置
            required_keys = [
                'telegram.bot_token',
                'telegram.channel_id',
                'mysql.host',
                'mysql.username',
                'mysql.password',
                'mysql.database',
                'admin.user_ids'
            ]

            for key in required_keys:
                keys = key.split('.')
                value = self.config
                for k in keys:
                    if k not in value:
                        logger.error(f"配置缺失: {key}")
                        return False
                    value = value[k]

            logger.info("配置文件加载成功")
            return True
        except json.JSONDecodeError as e:
            logger.error(f"配置文件格式错误: {e}")
            return False
        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return False

    @property
    def bot_token(self) -> str:
        return self.config['telegram']['bot_token']

    @property
    def channel_id(self) -> int:
        return int(self.config['telegram']['channel_id'])

    @property
    def mysql_config(self) -> Dict[str, Any]:
        return self.config['mysql']

    @property
    def admin_ids(self) -> set:
        return set(self.config['admin']['user_ids'])
