package androidpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	webPushAuthSecretSize    = 16
	webPushHeaderSize        = 16 + 4 + 1 + 65
	webPushTagSize           = 16
	webPushMaxCiphertextSize = 4096
)

func decodeWebPushKeys(p256dh, auth string) ([]byte, []byte, error) {
	if strings.ContainsAny(p256dh, "=+/") || strings.ContainsAny(auth, "=+/") {
		return nil, nil, errors.New("web push keys must use unpadded base64url encoding")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(p256dh)
	if err != nil {
		return nil, nil, errors.New("invalid p256dh key")
	}
	if len(publicKey) != 65 {
		return nil, nil, errors.New("p256dh key must be an uncompressed P-256 public key")
	}
	if _, err := ecdh.P256().NewPublicKey(publicKey); err != nil {
		return nil, nil, errors.New("invalid p256dh key")
	}
	authSecret, err := base64.RawURLEncoding.DecodeString(auth)
	if err != nil || len(authSecret) != webPushAuthSecretSize {
		return nil, nil, fmt.Errorf("auth key must decode to %d bytes", webPushAuthSecretSize)
	}
	return publicKey, authSecret, nil
}

func encryptWebPush(plaintext, receiverPublicKey, authSecret []byte) ([]byte, error) {
	return encryptWebPushWithRandom(plaintext, receiverPublicKey, authSecret, rand.Reader)
}

func encryptWebPushWithRandom(plaintext, receiverPublicKey, authSecret []byte, random io.Reader) ([]byte, error) {
	if webPushHeaderSize+len(plaintext)+1+webPushTagSize > webPushMaxCiphertextSize {
		return nil, errors.New("web push payload exceeds one RFC 8291 message")
	}
	if len(authSecret) != webPushAuthSecretSize {
		return nil, errors.New("invalid web push auth secret")
	}
	receiverKey, err := ecdh.P256().NewPublicKey(receiverPublicKey)
	if err != nil {
		return nil, errors.New("invalid web push public key")
	}
	senderKey, err := ecdh.P256().GenerateKey(random)
	if err != nil {
		return nil, fmt.Errorf("generate web push sender key: %w", err)
	}
	sharedSecret, err := senderKey.ECDH(receiverKey)
	if err != nil {
		return nil, fmt.Errorf("derive web push shared secret: %w", err)
	}
	senderPublicKey := senderKey.PublicKey().Bytes()

	keyInfo := make([]byte, 0, len("WebPush: info\x00")+len(receiverPublicKey)+len(senderPublicKey))
	keyInfo = append(keyInfo, "WebPush: info\x00"...)
	keyInfo = append(keyInfo, receiverPublicKey...)
	keyInfo = append(keyInfo, senderPublicKey...)
	ikm := hkdfExpand(hkdfExtract(authSecret, sharedSecret), keyInfo, 32)

	salt := make([]byte, 16)
	if _, err := io.ReadFull(random, salt); err != nil {
		return nil, fmt.Errorf("generate web push salt: %w", err)
	}
	contentKey := hkdfExpand(
		hkdfExtract(salt, ikm),
		[]byte("Content-Encoding: aes128gcm\x00"),
		16,
	)
	nonce := hkdfExpand(
		hkdfExtract(salt, ikm),
		[]byte("Content-Encoding: nonce\x00"),
		12,
	)
	block, err := aes.NewCipher(contentKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	record := make([]byte, len(plaintext)+1)
	copy(record, plaintext)
	record[len(plaintext)] = 2
	recordSize := uint32(len(record) + gcm.Overhead())

	body := make([]byte, webPushHeaderSize, webPushHeaderSize+len(record)+gcm.Overhead())
	copy(body, salt)
	binary.BigEndian.PutUint32(body[16:20], recordSize)
	body[20] = byte(len(senderPublicKey))
	copy(body[21:], senderPublicKey)
	return gcm.Seal(body, nonce, record, nil), nil
}

func hkdfExtract(salt, input []byte) []byte {
	mac := hmac.New(sha256.New, salt)
	_, _ = mac.Write(input)
	return mac.Sum(nil)
}

func hkdfExpand(pseudorandomKey, info []byte, length int) []byte {
	mac := hmac.New(sha256.New, pseudorandomKey)
	_, _ = mac.Write(info)
	_, _ = mac.Write([]byte{1})
	return mac.Sum(nil)[:length]
}
