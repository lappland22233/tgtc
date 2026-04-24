package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"

	"github.com/tg-imagebed-refactored/internal/config"
	"github.com/tg-imagebed-refactored/internal/handler"
	"github.com/tg-imagebed-refactored/internal/middleware"
	"github.com/tg-imagebed-refactored/internal/repository"
	"github.com/tg-imagebed-refactored/internal/service"
)

func main() {
	// 加载配置
	configPath := "config.json"
	if envPath := os.Getenv("CONFIG_PATH"); envPath != "" {
		configPath = envPath
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 初始化数据库
	db, err := initDB(cfg.Database)
	if err != nil {
		log.Fatalf("数据库初始化失败: %v", err)
	}
	defer db.Close()

	// 初始化仓库
	userRepo := repository.NewUserRepository(db)
	logRepo := repository.NewAdminLogRepository(db)
	banRepo := repository.NewBanRepository(db)
	statsRepo := repository.NewStatsRepository(db)

	// 初始化服务
	authService := service.NewAuthService(userRepo, logRepo, &cfg.JWT)
	userService := service.NewUserService(userRepo, logRepo)
	statsService := service.NewStatsService(statsRepo)

	// 初始化处理器
	authHandler := handler.NewAuthHandler(authService)
	userHandler := handler.NewUserHandler(userService)
	statsHandler := handler.NewStatsHandler(statsService)

	// 初始化中间件
	authMiddleware := middleware.NewAuthMiddleware(authService)

	// 创建路由
	mux := http.NewServeMux()

	// 公开接口
	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.HandleFunc("/api/auth/refresh", authHandler.RefreshToken)

	// 需要认证的接口
	authRequired := authMiddleware.Authenticate
	mux.HandleFunc("/api/auth/me", authRequired(authHandler.GetMe))
	mux.HandleFunc("/api/auth/logout", authRequired(authHandler.Logout))

	// 用户管理接口（需要超级管理员权限）
	mux.HandleFunc("/api/users", authRequired(authMiddleware.RequireSuperAdmin(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			userHandler.ListUsers(w, r)
		case http.MethodPost:
			userHandler.CreateUser(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})))

	mux.HandleFunc("/api/users/update", authRequired(authMiddleware.RequireSuperAdmin(userHandler.UpdateUser)))
	mux.HandleFunc("/api/users/delete", authRequired(authMiddleware.RequireSuperAdmin(userHandler.DeleteUser)))
	mux.HandleFunc("/api/users/change-password", authRequired(userHandler.ChangePassword))

	// 管理员接口（需要admin或更高权限）
	mux.HandleFunc("/api/stats", authRequired(authMiddleware.RequireAdmin(statsHandler.GetStats)))

	// 应用中间件
	adminMux := applyMiddleware(mux)

	// 创建服务器
	srv := &http.Server{
		Addr:         cfg.Server.GetAddr(),
		Handler:      adminMux,
		ReadTimeout:  10 * 1e9, // 10秒
		WriteTimeout: 30 * 1e9, // 30秒
		IdleTimeout:  60 * 1e9, // 60秒
	}

	// 启动服务器
	go func() {
		log.Printf("服务启动: %s", cfg.Server.GetAddr())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务器启动失败: %v", err)
		}
	}()

	// 等待中断信号
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("正在关闭服务器...")
}

// initDB 初始化数据库连接
func initDB(cfg config.DatabaseConfig) (*sql.DB, error) {
	db, err := sql.Open("mysql", cfg.GetDSN())
	if err != nil {
		return nil, err
	}

	// 连接池配置
	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.GetConnMaxLifetime())

	// 测试连接
	if err := db.Ping(); err != nil {
		return nil, err
	}

	log.Println("数据库连接成功")
	return db, nil
}

// applyMiddleware 应用中间件
func applyMiddleware(h http.Handler) http.Handler {
	return middleware.CORSMiddleware(func(w http.ResponseWriter, r *http.Request) {
		h.ServeHTTP(w, r)
	})
}
